/**
 * Dead Man's Switch — Preview Testnet Integration Test
 *
 * Exercises the dead_mans_switch.dead_mans_switch.spend validator end-to-end:
 *   1. Lock: Send 5 tADA to script with SwitchDatum (deadline in the past)
 *   2. OwnerWithdraw: Owner reclaims funds (simple spend, no continuing output)
 *   3. Lock again: Send 5 tADA with future deadline for checkin test
 *   4. CheckIn: Owner extends deadline via continuing output pattern
 *
 * SwitchDatum:
 *   { owner: ByteArray, beneficiary: ByteArray, check_in_deadline: Int, check_in_interval: Int }
 *   ConStr0 with [bytes, bytes, int, int]
 *
 * SwitchAction (redeemer):
 *   CheckIn (ConStr0) — owner extends deadline, requires continuing output with updated datum
 *   Claim (ConStr1) — beneficiary claims after deadline (time-locked)
 *   OwnerWithdraw (ConStr2) — owner withdraws anytime
 *
 * The continuing output pattern (CheckIn):
 *   The validator reads tx.validity_range.lower_bound as current_time (via Finite(current_time)).
 *   It then requires exactly one continuing output to the same script address with an inline datum
 *   where check_in_deadline == current_time + check_in_interval, and all other fields unchanged.
 *   The invalidBefore slot determines the current_time used for the new deadline calculation.
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/dead-mans-switch.ts lock              # Lock 5 tADA with past deadline
 *   npx tsx test/dead-mans-switch.ts owner-withdraw    # Owner reclaims funds
 *   npx tsx test/dead-mans-switch.ts lock-future       # Lock 5 tADA with future deadline
 *   npx tsx test/dead-mans-switch.ts checkin           # Check in — continuing output with updated deadline
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
const STATE_FILE = join(__dirname, "dead-mans-switch-state.json");

// Preview testnet slot config: slot 0 = 2022-10-25T00:00:00Z = 1666656000 (Unix seconds)
// 1 second per slot
const PREVIEW_SLOT_ZERO_UNIX = 1666656000;

// Check-in interval: 1 day in milliseconds
const CHECK_IN_INTERVAL = 86_400_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeadMansSwitchTestState {
  scriptAddress: string;
  scriptCbor: string;
  scriptHash: string;
  lockTxHash?: string;
  lockTxIndex?: number;
  checkInDeadlineMs?: number;
  checkInIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[dead-mans-switch-test] ${msg}`);
}

function saveState(state: DeadMansSwitchTestState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): DeadMansSwitchTestState | null {
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

/**
 * Convert preview testnet slot number to POSIX milliseconds.
 */
function slotToPosixMs(slot: number): number {
  return (slot + PREVIEW_SLOT_ZERO_UNIX) * 1000;
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

  // Load the dead_mans_switch validator — non-parameterized spend validator
  const compiledCode = loadValidatorCompiledCode("dead_mans_switch.dead_mans_switch.spend");

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
// Test: Lock (send 5 tADA to script with SwitchDatum — past deadline)
// ---------------------------------------------------------------------------

async function testLock() {
  const ctx = await setup();

  // Set deadline to 10 minutes in the past so we can test Claim immediately
  const deadlineMs = Date.now() - 10 * 60 * 1000;
  log(`Deadline: ${deadlineMs} (${new Date(deadlineMs).toISOString()}) — 10 min in the past`);
  log(`Check-in interval: ${CHECK_IN_INTERVAL}ms (1 day)`);

  // Build SwitchDatum: { owner, beneficiary, check_in_deadline, check_in_interval }
  // Using same key for both owner and beneficiary (we only have one wallet)
  const datum = {
    constructor: 0,
    fields: [
      { bytes: ctx.keyHashHex },   // owner
      { bytes: ctx.keyHashHex },   // beneficiary (same wallet in test)
      { int: deadlineMs },         // check_in_deadline: 10 min in the past
      { int: CHECK_IN_INTERVAL },  // check_in_interval: 1 day
    ],
  };

  const lockAmount = "5000000"; // 5 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at dead man's switch script address...`);

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
  const state: DeadMansSwitchTestState = {
    scriptAddress: ctx.scriptAddress,
    scriptCbor: ctx.scriptCbor,
    scriptHash: ctx.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
    checkInDeadlineMs: deadlineMs,
    checkInIntervalMs: CHECK_IN_INTERVAL,
  };
  saveState(state);
  log("State saved to test/dead-mans-switch-state.json");
}

// ---------------------------------------------------------------------------
// Test: Lock with future deadline (for checkin test)
// ---------------------------------------------------------------------------

async function testLockFuture() {
  const ctx = await setup();

  // Set deadline to 10 minutes in the future — checkin should still work
  // because checkin just requires owner signature + correct continuing output
  const deadlineMs = Date.now() + 10 * 60 * 1000;
  log(`Deadline: ${deadlineMs} (${new Date(deadlineMs).toISOString()}) — 10 min in the future`);
  log(`Check-in interval: ${CHECK_IN_INTERVAL}ms (1 day)`);

  const datum = {
    constructor: 0,
    fields: [
      { bytes: ctx.keyHashHex },   // owner
      { bytes: ctx.keyHashHex },   // beneficiary (same wallet in test)
      { int: deadlineMs },         // check_in_deadline: 10 min in the future
      { int: CHECK_IN_INTERVAL },  // check_in_interval: 1 day
    ],
  };

  const lockAmount = "5000000"; // 5 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at dead man's switch script address (future deadline)...`);

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
  log("Lock (future) transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);

  const state: DeadMansSwitchTestState = {
    scriptAddress: ctx.scriptAddress,
    scriptCbor: ctx.scriptCbor,
    scriptHash: ctx.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
    checkInDeadlineMs: deadlineMs,
    checkInIntervalMs: CHECK_IN_INTERVAL,
  };
  saveState(state);
  log("State saved to test/dead-mans-switch-state.json");
}

// ---------------------------------------------------------------------------
// Test: OwnerWithdraw (owner reclaims funds — simple spend, no continuing output)
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

  // OwnerWithdraw redeemer: ConStr2 (constructor index 2, no fields)
  // Validator only checks: list.has(tx.extra_signatories, d.owner)
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
    // Required signer — validator checks tx.extra_signatories for owner
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .complete();

  txBuilder.completeSigning();
  log("OwnerWithdraw transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("Owner withdrew funds — dead man's switch cleared");
}

// ---------------------------------------------------------------------------
// Test: CheckIn (continuing output pattern + time validation)
// ---------------------------------------------------------------------------

async function testCheckIn() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to check in — run 'lock' or 'lock-future' first");
    return;
  }

  const ctx = await setup();
  const checkInInterval = state.checkInIntervalMs ?? CHECK_IN_INTERVAL;

  log(`Checking in: ${state.lockTxHash}#${state.lockTxIndex}`);
  log(`Current deadline: ${state.checkInDeadlineMs} (${new Date(state.checkInDeadlineMs!).toISOString()})`);
  log(`Check-in interval: ${checkInInterval}ms`);

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

  // CheckIn redeemer: ConStr0 (constructor index 0, no fields)
  const redeemer = { constructor: 0, fields: [] };

  // The validator reads tx.validity_range.lower_bound as current_time.
  // We set invalidBefore to a recent slot (60s in the past) to ensure the ledger
  // has already passed it. This avoids "submitted too early" errors from clock skew.
  // The POSIX ms for this slot becomes the current_time the validator uses.
  const currentSlot = posixMsToSlot(Date.now());
  const invalidBeforeSlot = currentSlot - 60; // 1 minute in the past — safe margin
  const currentTimePosixMs = slotToPosixMs(invalidBeforeSlot);
  const invalidHereafterSlot = currentSlot + 900; // 15 minutes from now

  log(`invalidBefore slot: ${invalidBeforeSlot} (POSIX ms: ${currentTimePosixMs})`);
  log(`invalidHereafter slot: ${invalidHereafterSlot}`);

  // New deadline = current_time (from lower bound) + check_in_interval
  const newDeadline = currentTimePosixMs + checkInInterval;
  log(`New deadline: ${newDeadline} (${new Date(newDeadline).toISOString()})`);

  // Build the new datum — all immutable fields preserved, only check_in_deadline updated
  const newDatum = {
    constructor: 0,
    fields: [
      { bytes: ctx.keyHashHex },         // owner (unchanged)
      { bytes: ctx.keyHashHex },         // beneficiary (unchanged)
      { int: newDeadline },              // check_in_deadline (updated)
      { int: checkInInterval },          // check_in_interval (unchanged)
    ],
  };

  const continuingAmount = "5000000"; // 5 tADA — same amount back to script

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
    // CONTINUING OUTPUT — the validator checks this output exists at the same script
    // address with updated check_in_deadline and all other fields unchanged
    .txOut(state.scriptAddress, [
      { unit: "lovelace", quantity: continuingAmount },
    ])
    .txOutInlineDatumValue(newDatum, "JSON")
    // Validity range — invalidBefore sets the lower_bound that the validator reads
    // as current_time for computing the new deadline
    .invalidBefore(invalidBeforeSlot)
    .invalidHereafter(invalidHereafterSlot)
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — validator checks tx.extra_signatories for owner
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    // Wallet UTxOs for fee coverage (script input nets to zero: 5 ADA in, 5 ADA out)
    .selectUtxosFrom(walletUtxos)
    .complete();

  txBuilder.completeSigning();
  log("CheckIn transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log(`Checked in — deadline extended to ${new Date(newDeadline).toISOString()}`);

  // Update state — the continuing output is at index 0 (first txOut)
  const newState: DeadMansSwitchTestState = {
    scriptAddress: state.scriptAddress,
    scriptCbor: state.scriptCbor,
    scriptHash: state.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
    checkInDeadlineMs: newDeadline,
    checkInIntervalMs: checkInInterval,
  };
  saveState(newState);
  log("State updated — new UTxO tracks the continuing output");
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
    case "lock-future":
      await testLockFuture();
      break;
    case "owner-withdraw":
      await testOwnerWithdraw();
      break;
    case "checkin":
      await testCheckIn();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/dead-mans-switch.ts [lock|owner-withdraw|lock-future|checkin]");
      process.exit(1);
  }
} catch (err) {
  console.error("[dead-mans-switch-test] ERROR:", err);
  process.exit(1);
}
