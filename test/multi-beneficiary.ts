/**
 * Multi-Beneficiary Inheritance Vault — Preview Testnet Integration Tests
 *
 * Exercises the multi_beneficiary.multi_beneficiary.spend validator end-to-end:
 *   1. Lock: Send 10 tADA to the script with InheritanceDatum (deadline in the past)
 *   2. Owner Withdraw: Spend with OwnerWithdraw redeemer (no time constraint)
 *   3. Lock again, then Claim: Spend with ClaimShare { beneficiary_index: 0, output_index: 0 }
 *      - Time-locked: invalidBefore must be after unlock_after
 *      - Output at index 0 must pay beneficiary >= their share (50% of 10 ADA = 5 ADA)
 *
 * The validator is non-parameterized — compiledCode IS the final script.
 *
 * InheritanceDatum:
 *   owner: ByteArray (28-byte vkh)
 *   beneficiaries: List<Pair<ByteArray, Int>> — encoded as Plutus map in JSON
 *   unlock_after: Int (POSIX ms)
 *
 * InheritanceRedeemer:
 *   OwnerWithdraw (ConStr0) — owner signs, no time restriction
 *   ClaimShare { beneficiary_index: Int, output_index: Int } (ConStr1)
 *     — beneficiary signs, time must be after unlock_after,
 *       output at output_index pays beneficiary >= (input_lovelace * share_bps / 10000)
 *
 * We use one wallet as both owner and beneficiary. Two beneficiary entries
 * point to the same key hash: [(our_key, 5000), (our_key, 5000)] = 50% + 50%.
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/multi-beneficiary.ts lock              # Lock 10 tADA at script
 *   npx tsx test/multi-beneficiary.ts owner-withdraw    # Owner withdraws everything
 *   npx tsx test/multi-beneficiary.ts claim             # Beneficiary claims 50% share
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

// Node.js 20 lacks global WebSocket — polyfill for Ogmios provider
(globalThis as any).WebSocket = WebSocket;

import {
  SpendingBlueprint,
  MeshTxBuilder,
} from "@meshsdk/core";
import { KupoProvider, OgmiosProvider } from "@meshsdk/provider";
import { AppWallet } from "@meshsdk/wallet";

import { config, loadSigningKey, loadValidatorCompiledCode } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "multi-beneficiary-state.json");

// Preview testnet slot config: slot 0 = 2022-10-25T00:00:00Z = 1666656000 (Unix seconds)
// 1 second per slot
const PREVIEW_SLOT_ZERO_UNIX = 1666656000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MultiBeneficiaryTestState {
  scriptAddress: string;
  scriptCbor: string;
  scriptHash: string;
  lockTxHash?: string;
  lockTxIndex?: number;
  deadlineMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[multi-beneficiary-test] ${msg}`);
}

function saveState(state: MultiBeneficiaryTestState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): MultiBeneficiaryTestState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
}

/**
 * Convert POSIX milliseconds to preview testnet slot number.
 * Preview: slot 0 = 1666656000 Unix seconds, 1 second per slot.
 */
function posixMsToSlot(posixMs: number): number {
  return Math.floor(posixMs / 1000) - PREVIEW_SLOT_ZERO_UNIX;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function setup() {
  log("Connecting to preview testnet...");

  const ogmios = new OgmiosProvider(config.ogmiosUrl);
  const kupo = new KupoProvider(config.kupoUrl);

  // Load wallet
  const signingKey = loadSigningKey();
  const wallet = new AppWallet({
    networkId: config.networkId,
    fetcher: kupo,
    submitter: ogmios,
    key: {
      type: "cli",
      payment: signingKey,
    },
  });
  await wallet.init();

  // Use enterprise address — the funded preview wallet has no stake key
  const walletAddress = wallet.getEnterpriseAddress();
  log(`Wallet address: ${walletAddress}`);

  // Check UTxOs
  const utxos = await kupo.fetchAddressUTxOs(walletAddress);
  const totalLovelace = utxos.reduce((sum, u) => {
    const lovelace = u.output.amount.find((a) => a.unit === "lovelace");
    return sum + BigInt(lovelace?.quantity ?? "0");
  }, 0n);
  log(`UTxOs: ${utxos.length}, Balance: ${totalLovelace / 1_000_000n} tADA`);

  if (utxos.length === 0) {
    throw new Error(
      "No UTxOs found — wallet may not be funded or Kupo not synced to tip"
    );
  }

  // Extract the payment key hash from wallet enterprise address
  // toBytes() returns hex string: 1 byte header (2 hex chars) + 28 bytes key hash (56 hex chars)
  const usedAddr = wallet.getUsedAddress(0, 0, "enterprise");
  const addrHex = usedAddr.toBytes() as unknown as string;
  const keyHashHex = addrHex.slice(2, 58);
  log(`Key hash: ${keyHashHex}`);

  // Load the multi_beneficiary validator — non-parameterized spend validator
  const compiledCode = loadValidatorCompiledCode("multi_beneficiary.multi_beneficiary.spend");

  // SpendingBlueprint: (version, networkId, stakeHash, isStakeScriptCredential?)
  // Empty stakeHash for enterprise-style script address (no staking credential)
  const blueprint = new SpendingBlueprint("V3", 0, "");
  blueprint.noParamScript(compiledCode);

  const scriptHash = blueprint.hash;
  const scriptCbor = blueprint.cbor;
  const scriptAddress = blueprint.address;

  log(`Script hash: ${scriptHash}`);
  log(`Script address: ${scriptAddress}`);

  return {
    ogmios,
    kupo,
    wallet,
    walletAddress,
    scriptHash,
    scriptCbor,
    scriptAddress,
    keyHashHex,
    signingKey,
  };
}

// ---------------------------------------------------------------------------
// Test: Lock (send 10 tADA to script with InheritanceDatum)
// ---------------------------------------------------------------------------

async function testLock() {
  const ctx = await setup();

  // Set deadline to 10 minutes in the past so we can test ClaimShare immediately
  const deadlineMs = Date.now() - 10 * 60 * 1000;
  log(`Deadline: ${deadlineMs} (${new Date(deadlineMs).toISOString()}) — 10 min in the past`);

  // Build InheritanceDatum:
  //   ConStr0 [ owner: ByteArray, beneficiaries: Map<ByteArray, Int>, unlock_after: Int ]
  //
  // beneficiaries is List<Pair<ByteArray, Int>> which the Aiken blueprint encodes
  // as a Plutus map. Two entries: (our_key, 5000) + (our_key, 5000) = 50% + 50%.
  //
  // IMPORTANT: Plutus maps allow duplicate keys. Two identical key entries is valid
  // and the validator uses list.at() on the decoded list, so both entries are accessible.
  const datum = {
    constructor: 0,
    fields: [
      { bytes: ctx.keyHashHex },     // owner
      { map: [                        // beneficiaries: List<Pair<ByteArray, Int>>
        { k: { bytes: ctx.keyHashHex }, v: { int: 5000 } },  // 50% to us
        { k: { bytes: ctx.keyHashHex }, v: { int: 5000 } },  // 50% to us
      ]},
      { int: deadlineMs },           // unlock_after (in the past for testing)
    ],
  };

  const lockAmount = "10000000"; // 10 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at multi-beneficiary script address...`);

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
  });

  await txBuilder
    // Output: ADA + inline datum to script address
    .txOut(ctx.scriptAddress, [
      { unit: "lovelace", quantity: lockAmount },
    ])
    .txOutInlineDatumValue(datum, "JSON")
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress))
    .complete();

  txBuilder.completeSigning();
  log("Lock transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);

  // The locked UTxO will be at output index 0 (first txOut in the builder)
  const state: MultiBeneficiaryTestState = {
    scriptAddress: ctx.scriptAddress,
    scriptCbor: ctx.scriptCbor,
    scriptHash: ctx.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
    deadlineMs,
  };
  saveState(state);
  log("State saved to test/multi-beneficiary-state.json");
}

// ---------------------------------------------------------------------------
// Test: Owner Withdraw (owner reclaims everything, no time constraint)
// ---------------------------------------------------------------------------

async function testOwnerWithdraw() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to withdraw — run 'lock' first");
    return;
  }

  const ctx = await setup();

  log(`Owner withdrawing: ${state.lockTxHash}#${state.lockTxIndex}`);

  // Find the locked UTxO at the script address
  const scriptUtxos = await ctx.kupo.fetchAddressUTxOs(state.scriptAddress);
  const lockedUtxo = scriptUtxos.find(
    (u) =>
      u.input.txHash === state.lockTxHash &&
      u.input.outputIndex === state.lockTxIndex
  );

  if (!lockedUtxo) {
    log("Locked UTxO not found at script address — already spent or Kupo not synced");
    log(`Searched ${scriptUtxos.length} UTxOs at ${state.scriptAddress}`);
    return;
  }

  log(`Found locked UTxO: ${lockedUtxo.output.amount.map((a) => `${a.quantity} ${a.unit}`).join(", ")}`);

  // Find a pure-ADA UTxO for collateral (from our wallet, not the script)
  const walletUtxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);
  const collateralUtxo = walletUtxos.find(
    (u) => u.output.amount.length === 1 && u.output.amount[0].unit === "lovelace"
  );
  if (!collateralUtxo) {
    log("No pure-ADA UTxO available for collateral");
    return;
  }
  log(`Collateral UTxO: ${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`);

  // OwnerWithdraw redeemer: ConStr0 (constructor index 0, no fields)
  // Validator requires: list.has(tx.extra_signatories, d.owner)
  const redeemer = { constructor: 0, fields: [] };

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    // Spend the script UTxO with Plutus V3
    .spendingPlutusScriptV3()
    .txIn(lockedUtxo.input.txHash, lockedUtxo.input.outputIndex)
    .txInScript(state.scriptCbor)
    .txInInlineDatumPresent()
    .txInRedeemerValue(redeemer, "JSON")
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — validator checks tx.extra_signatories for owner
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .complete();

  txBuilder.completeSigning();
  log("Owner withdraw transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("Owner withdrew — all funds reclaimed");
}

// ---------------------------------------------------------------------------
// Test: Claim Share (beneficiary claims their share after unlock time)
// ---------------------------------------------------------------------------

async function testClaim() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to claim — run 'lock' first");
    return;
  }

  const ctx = await setup();

  log(`Claiming beneficiary share: ${state.lockTxHash}#${state.lockTxIndex}`);
  log(`Deadline was: ${state.deadlineMs} (${new Date(state.deadlineMs!).toISOString()})`);

  // Find the locked UTxO at the script address
  const scriptUtxos = await ctx.kupo.fetchAddressUTxOs(state.scriptAddress);
  const lockedUtxo = scriptUtxos.find(
    (u) =>
      u.input.txHash === state.lockTxHash &&
      u.input.outputIndex === state.lockTxIndex
  );

  if (!lockedUtxo) {
    log("Locked UTxO not found at script address — already spent or Kupo not synced");
    log(`Searched ${scriptUtxos.length} UTxOs at ${state.scriptAddress}`);
    return;
  }

  const lockedLovelace = lockedUtxo.output.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0";
  log(`Found locked UTxO: ${lockedUtxo.output.amount.map((a) => `${a.quantity} ${a.unit}`).join(", ")}`);

  // Find a pure-ADA UTxO for collateral (from our wallet, not the script)
  const walletUtxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);
  const collateralUtxo = walletUtxos.find(
    (u) => u.output.amount.length === 1 && u.output.amount[0].unit === "lovelace"
  );
  if (!collateralUtxo) {
    log("No pure-ADA UTxO available for collateral");
    return;
  }
  log(`Collateral UTxO: ${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`);

  // ClaimShare redeemer: ConStr1 { beneficiary_index: 0, output_index: 0 }
  // Claiming as the first beneficiary (index 0), output at index 0
  const redeemer = {
    constructor: 1,
    fields: [
      { int: 0 },  // beneficiary_index
      { int: 0 },  // output_index
    ],
  };

  // The validator checks output at output_index (0) pays beneficiary >= their share.
  // Share is input_lovelace * 5000 / 10000 = 50% of the locked amount.
  // The validator uses address.from_verification_key(beneficiary_key) which creates
  // an enterprise address (no stake key) — so we must pay to our enterprise address.
  const shareLovelace = BigInt(lockedLovelace) * 5000n / 10000n;
  log(`Beneficiary share: ${shareLovelace} lovelace (50% of ${lockedLovelace})`);

  // The validator checks: interval.is_entirely_after(tx.validity_range, d.unlock_after)
  // This means the tx validity range lower bound must be > deadline.
  const deadlineSlot = posixMsToSlot(state.deadlineMs!);
  // Set invalidBefore to deadline + 1 slot to ensure "entirely after"
  const invalidBeforeSlot = deadlineSlot + 1;
  log(`Deadline slot: ${deadlineSlot}, invalidBefore slot: ${invalidBeforeSlot}`);

  // Also set invalidHereafter so the validity range is bounded
  const currentSlot = posixMsToSlot(Date.now());
  const invalidHereafterSlot = currentSlot + 900; // 15 minutes from now
  log(`Current slot: ~${currentSlot}, invalidHereafter: ${invalidHereafterSlot}`);

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    // Output at index 0 — must pay beneficiary >= their share
    // This must be the FIRST txOut so it's at output index 0 (matching the redeemer)
    .txOut(ctx.walletAddress, [
      { unit: "lovelace", quantity: shareLovelace.toString() },
    ])
    // Spend the script UTxO with Plutus V3
    .spendingPlutusScriptV3()
    .txIn(lockedUtxo.input.txHash, lockedUtxo.input.outputIndex)
    .txInScript(state.scriptCbor)
    .txInInlineDatumPresent()
    .txInRedeemerValue(redeemer, "JSON")
    // Validity range — must be entirely after deadline
    .invalidBefore(invalidBeforeSlot)
    .invalidHereafter(invalidHereafterSlot)
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — validator checks tx.extra_signatories for beneficiary
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    // Wallet UTxOs for fee coverage
    .selectUtxosFrom(walletUtxos)
    .complete();

  txBuilder.completeSigning();
  log("Claim transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log(`Beneficiary claimed ${Number(shareLovelace) / 1_000_000} tADA (50% share)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2] || "lock";

try {
  switch (command) {
    case "lock":
      await testLock();
      break;
    case "owner-withdraw":
      await testOwnerWithdraw();
      break;
    case "claim":
      await testClaim();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/multi-beneficiary.ts [lock|owner-withdraw|claim]");
      process.exit(1);
  }
} catch (err) {
  console.error("[multi-beneficiary-test] ERROR:", err);
  process.exit(1);
}
