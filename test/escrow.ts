/**
 * Escrow Validator — Preview Testnet Integration Tests
 *
 * Exercises the escrow spend validator end-to-end on the preview testnet:
 *   1. Lock: Send ADA to the escrow script address with an EscrowDatum
 *   2. Complete: Both seller and buyer sign to release funds
 *   3. Cancel: Seller cancels and reclaims funds (no time constraint)
 *   4. Refund: Seller reclaims funds after deadline has passed
 *
 * The validator is non-parameterized — compiledCode IS the final script.
 *
 * EscrowDatum:
 *   seller: ByteArray (28-byte vkh), buyer: ByteArray (28-byte vkh),
 *   price: Int (lovelace), deadline: Int (POSIX ms)
 *
 * EscrowRedeemer:
 *   Complete (ConStr0) — both seller and buyer sign
 *   Refund (ConStr1) — seller signs, validity range entirely after deadline
 *   Cancel (ConStr2) — seller signs (anytime)
 *
 * Since we only have one test wallet, seller and buyer are the same key hash.
 * The validator just checks tx.extra_signatories, so this is valid.
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/escrow.ts lock        # Lock 5 tADA at escrow script
 *   npx tsx test/escrow.ts complete    # Complete — both parties sign
 *   npx tsx test/escrow.ts cancel      # Cancel — seller reclaims
 *   npx tsx test/escrow.ts refund      # Refund — seller reclaims after deadline
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
const STATE_FILE = join(__dirname, "escrow-state.json");

// Preview testnet slot config: slot 0 = 2022-10-25T00:00:00Z = 1666656000 (Unix seconds)
// 1 second per slot
const PREVIEW_SLOT_ZERO_UNIX = 1666656000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EscrowTestState {
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
  console.log(`[escrow-test] ${msg}`);
}

function saveState(state: EscrowTestState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): EscrowTestState | null {
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

  // Load the escrow validator — non-parameterized spend validator
  const compiledCode = loadValidatorCompiledCode("escrow.escrow.spend");

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
// Test: Lock
// ---------------------------------------------------------------------------

async function testLock() {
  const ctx = await setup();

  // Set deadline to 10 minutes in the past so we can test Refund immediately
  const deadlineMs = Date.now() - 10 * 60 * 1000;
  log(`Deadline: ${deadlineMs} (${new Date(deadlineMs).toISOString()}) — 10 min in the past`);

  // Build EscrowDatum: { seller: ByteArray, buyer: ByteArray, price: Int, deadline: Int }
  // Using same key for both seller and buyer (we only have one wallet)
  const datum = {
    constructor: 0,
    fields: [
      { bytes: ctx.keyHashHex },   // seller
      { bytes: ctx.keyHashHex },   // buyer (same wallet in test)
      { int: 5_000_000 },          // price: 5 ADA
      { int: deadlineMs },         // deadline: 10 min in the past
    ],
  };

  const lockAmount = "5000000"; // 5 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at escrow script address...`);

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
  const state: EscrowTestState = {
    scriptAddress: ctx.scriptAddress,
    scriptCbor: ctx.scriptCbor,
    scriptHash: ctx.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
    deadlineMs,
  };
  saveState(state);
  log("State saved to test/escrow-state.json");
}

// ---------------------------------------------------------------------------
// Test: Complete (both seller and buyer sign)
// ---------------------------------------------------------------------------

async function testComplete() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to complete — run 'lock' first");
    return;
  }

  const ctx = await setup();

  log(`Completing escrow: ${state.lockTxHash}#${state.lockTxIndex}`);

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

  // Complete redeemer: ConStr0 (constructor index 0, no fields)
  // Validator requires both seller and buyer signatures.
  // Since seller == buyer in this test, one requiredSignerHash covers both.
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
    // Required signer — validator checks tx.extra_signatories for seller AND buyer
    // Both are our key hash in this test
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .complete();

  txBuilder.completeSigning();
  log("Complete transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("Escrow completed — funds released to wallet");
}

// ---------------------------------------------------------------------------
// Test: Cancel (seller cancels anytime)
// ---------------------------------------------------------------------------

async function testCancel() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to cancel — run 'lock' first");
    return;
  }

  const ctx = await setup();

  log(`Cancelling escrow: ${state.lockTxHash}#${state.lockTxIndex}`);

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

  // Cancel redeemer: ConStr2 (constructor index 2, no fields)
  // Validator only requires seller signature — no time constraint.
  const redeemer = { constructor: 2, fields: [] };

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
    // Required signer — validator checks tx.extra_signatories for seller
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .complete();

  txBuilder.completeSigning();
  log("Cancel transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("Escrow cancelled — funds returned to seller");
}

// ---------------------------------------------------------------------------
// Test: Refund (seller reclaims after deadline)
// ---------------------------------------------------------------------------

async function testRefund() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to refund — run 'lock' first");
    return;
  }

  const ctx = await setup();

  log(`Refunding escrow: ${state.lockTxHash}#${state.lockTxIndex}`);
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

  // Refund redeemer: ConStr1 (constructor index 1, no fields)
  // Validator requires: seller signature AND validity range entirely after deadline.
  const redeemer = { constructor: 1, fields: [] };

  // The validator checks: interval.is_entirely_after(tx.validity_range, d.deadline)
  // This means the tx validity range lower bound must be > deadline.
  // We set invalidBefore to a slot AFTER the deadline so the entire validity interval is after.
  // deadline is in POSIX milliseconds — convert to slot number.
  const deadlineSlot = posixMsToSlot(state.deadlineMs!);
  // Set invalidBefore to deadline + 1 slot (1 second) to ensure "entirely after"
  const invalidBeforeSlot = deadlineSlot + 1;
  log(`Deadline slot: ${deadlineSlot}, invalidBefore slot: ${invalidBeforeSlot}`);

  // Also set invalidHereafter so the validity range is bounded (required by protocol)
  const currentSlot = posixMsToSlot(Date.now());
  const invalidHereafterSlot = currentSlot + 900; // 15 minutes from now
  log(`Current slot: ~${currentSlot}, invalidHereafter: ${invalidHereafterSlot}`);

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
    // Validity range — must be entirely after deadline
    .invalidBefore(invalidBeforeSlot)
    .invalidHereafter(invalidHereafterSlot)
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — validator checks tx.extra_signatories for seller
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .complete();

  txBuilder.completeSigning();
  log("Refund transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("Escrow refunded — funds returned to seller after deadline");
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
    case "complete":
      await testComplete();
      break;
    case "cancel":
      await testCancel();
      break;
    case "refund":
      await testRefund();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/escrow.ts [lock|complete|cancel|refund]");
      process.exit(1);
  }
} catch (err) {
  console.error("[escrow-test] ERROR:", err);
  process.exit(1);
}
