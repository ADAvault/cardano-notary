/**
 * Validity Range — Preview Testnet Integration Test
 *
 * Exercises the validity_range.time_check.spend validator end-to-end:
 *   1. Lock: Send 5 tADA to script with Void datum
 *   2. Spend-after: Spend with MustBeAfter redeemer + invalidBefore
 *   3. Lock-again: Lock another 5 tADA (for spend-before test)
 *   4. Spend-before: Spend with MustBeBefore redeemer + invalidHereafter
 *
 * Datum: Data (ignored by validator, use Void: ConStr0 [])
 *
 * Redeemer types:
 *   MustBeAfter { deadline: Int }  → ConStr0 [int] (deadline in POSIX ms)
 *   MustBeBefore { deadline: Int } → ConStr1 [int] (deadline in POSIX ms)
 *
 * Validation:
 *   MustBeAfter: tx validity range lower bound > deadline
 *   MustBeBefore: tx validity range upper bound < deadline
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/validity-range.ts lock           # Lock 5 tADA with Void datum
 *   npx tsx test/validity-range.ts spend-after    # Spend with MustBeAfter (deadline in past)
 *   npx tsx test/validity-range.ts lock-again     # Lock another 5 tADA
 *   npx tsx test/validity-range.ts spend-before   # Spend with MustBeBefore (deadline in future)
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
const STATE_FILE = join(__dirname, "validity-range-state.json");

// Preview testnet slot config: slot 0 = 2022-10-25T00:00:00Z = 1666656000 (Unix seconds)
const PREVIEW_SLOT_ZERO_UNIX = 1666656000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ValidityRangeTestState {
  scriptAddress: string;
  scriptCbor: string;
  scriptHash: string;
  lockTxHash?: string;
  lockTxIndex?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[validity-range-test] ${msg}`);
}

function saveState(state: ValidityRangeTestState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): ValidityRangeTestState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
}

/**
 * Convert current time to preview testnet slot number.
 */
function currentSlot(): number {
  return Math.floor(Date.now() / 1000) - PREVIEW_SLOT_ZERO_UNIX;
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
  const usedAddr = wallet.getUsedAddress(0, 0, "enterprise");
  const addrHex = usedAddr.toBytes() as unknown as string;
  const keyHashHex = addrHex.slice(2, 58);
  log(`Key hash: ${keyHashHex}`);

  // Load the validity_range time_check validator — non-parameterized spend validator
  const compiledCode = loadValidatorCompiledCode("validity_range.time_check.spend");

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
// Test: Lock (send 5 tADA to script with Void datum)
// ---------------------------------------------------------------------------

async function testLock() {
  const ctx = await setup();

  // Void datum — validator ignores datum
  const datum = { constructor: 0, fields: [] };

  const lockAmount = "5000000"; // 5 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at time_check script address...`);

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
  });

  await txBuilder
    .txOut(ctx.scriptAddress, [
      { unit: "lovelace", quantity: lockAmount },
    ])
    .txOutInlineDatumValue(datum, "JSON")
    .changeAddress(ctx.walletAddress)
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress))
    .complete();

  txBuilder.completeSigning();
  log("Lock transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);

  const state: ValidityRangeTestState = {
    scriptAddress: ctx.scriptAddress,
    scriptCbor: ctx.scriptCbor,
    scriptHash: ctx.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
  };
  saveState(state);
  log("State saved to test/validity-range-state.json");
}

// ---------------------------------------------------------------------------
// Test: Spend-after (MustBeAfter redeemer + invalidBefore)
// ---------------------------------------------------------------------------

async function testSpendAfter() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to spend — run 'lock' first");
    return;
  }

  const ctx = await setup();

  log(`Spending (MustBeAfter): ${state.lockTxHash}#${state.lockTxIndex}`);

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

  // Find a pure-ADA UTxO for collateral
  const walletUtxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);
  const collateralUtxo = walletUtxos.find(
    (u) => u.output.amount.length === 1 && u.output.amount[0].unit === "lovelace"
  );
  if (!collateralUtxo) {
    log("No pure-ADA UTxO available for collateral");
    return;
  }
  log(`Collateral UTxO: ${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`);

  // MustBeAfter { deadline: 1 hour ago in POSIX ms }
  // Validator checks: tx validity range lower bound > deadline
  const deadlineMs = Date.now() - 3600_000; // 1 hour ago
  log(`Deadline: ${deadlineMs} (${new Date(deadlineMs).toISOString()}) — 1 hour ago`);

  const redeemer = {
    constructor: 0,
    fields: [
      { int: deadlineMs },
    ],
  };

  // Set invalidBefore to currentSlot - 60 (safety margin for clock skew)
  // This sets the lower bound of the validity range to ~now
  const slot = currentSlot();
  const invalidBeforeSlot = slot - 60;
  log(`invalidBefore slot: ${invalidBeforeSlot} (current slot: ${slot})`);

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    .spendingPlutusScriptV3()
    .txIn(lockedUtxo.input.txHash, lockedUtxo.input.outputIndex)
    .txInScript(state.scriptCbor)
    .txInInlineDatumPresent()
    .txInRedeemerValue(redeemer, "JSON")
    // Set lower bound of validity range
    .invalidBefore(invalidBeforeSlot)
    // Collateral
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(walletUtxos)
    .complete();

  txBuilder.completeSigning();
  log("Spend-after transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("MustBeAfter spend succeeded — validity range lower bound > deadline");
}

// ---------------------------------------------------------------------------
// Test: Lock again (for spend-before test)
// ---------------------------------------------------------------------------

async function testLockAgain() {
  const ctx = await setup();

  // Void datum
  const datum = { constructor: 0, fields: [] };

  const lockAmount = "5000000"; // 5 tADA
  log(`Locking another ${Number(lockAmount) / 1_000_000} tADA for spend-before test...`);

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
  });

  await txBuilder
    .txOut(ctx.scriptAddress, [
      { unit: "lovelace", quantity: lockAmount },
    ])
    .txOutInlineDatumValue(datum, "JSON")
    .changeAddress(ctx.walletAddress)
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress))
    .complete();

  txBuilder.completeSigning();
  log("Lock-again transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);

  const state: ValidityRangeTestState = {
    scriptAddress: ctx.scriptAddress,
    scriptCbor: ctx.scriptCbor,
    scriptHash: ctx.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
  };
  saveState(state);
  log("State saved to test/validity-range-state.json");
}

// ---------------------------------------------------------------------------
// Test: Spend-before (MustBeBefore redeemer + invalidHereafter)
// ---------------------------------------------------------------------------

async function testSpendBefore() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to spend — run 'lock-again' first");
    return;
  }

  const ctx = await setup();

  log(`Spending (MustBeBefore): ${state.lockTxHash}#${state.lockTxIndex}`);

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

  // Find a pure-ADA UTxO for collateral
  const walletUtxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);
  const collateralUtxo = walletUtxos.find(
    (u) => u.output.amount.length === 1 && u.output.amount[0].unit === "lovelace"
  );
  if (!collateralUtxo) {
    log("No pure-ADA UTxO available for collateral");
    return;
  }
  log(`Collateral UTxO: ${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`);

  // MustBeBefore { deadline: 1 hour from now in POSIX ms }
  // Validator checks: tx validity range upper bound < deadline
  const deadlineMs = Date.now() + 3600_000; // 1 hour from now
  log(`Deadline: ${deadlineMs} (${new Date(deadlineMs).toISOString()}) — 1 hour from now`);

  const redeemer = {
    constructor: 1,
    fields: [
      { int: deadlineMs },
    ],
  };

  // Set invalidHereafter to currentSlot + 120 (2 min from now)
  // This sets the upper bound of the validity range to ~2 min from now
  // Which is less than the deadline (1 hour from now) -> passes validator
  const slot = currentSlot();
  const invalidHereafterSlot = slot + 120;
  log(`invalidHereafter slot: ${invalidHereafterSlot} (current slot: ${slot})`);

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    .spendingPlutusScriptV3()
    .txIn(lockedUtxo.input.txHash, lockedUtxo.input.outputIndex)
    .txInScript(state.scriptCbor)
    .txInInlineDatumPresent()
    .txInRedeemerValue(redeemer, "JSON")
    // Set upper bound of validity range
    .invalidHereafter(invalidHereafterSlot)
    // Collateral
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(walletUtxos)
    .complete();

  txBuilder.completeSigning();
  log("Spend-before transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("MustBeBefore spend succeeded — validity range upper bound < deadline");
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
    case "spend-after":
      await testSpendAfter();
      break;
    case "lock-again":
      await testLockAgain();
      break;
    case "spend-before":
      await testSpendBefore();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/validity-range.ts [lock|spend-after|lock-again|spend-before]");
      process.exit(1);
  }
} catch (err) {
  console.error("[validity-range-test] ERROR:", err);
  process.exit(1);
}
