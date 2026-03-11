/**
 * State Machine (Counter) — Preview Testnet Integration Test
 *
 * Exercises the state_machine.counter.spend validator end-to-end:
 *   1. Lock: Send 5 tADA to script address with CounterState { count: 0, owner: key_hash }
 *   2. Increment: Spend UTxO with Increment redeemer, creating a continuing output
 *      back to the same script address with count+1 (the key pattern here)
 *   3. Reset: Spend the UTxO with Reset redeemer + owner signature (no continuing output)
 *
 * The continuing output pattern:
 *   When incrementing, the validator checks that exactly one output goes back to
 *   the same script address with an inline datum where count == old_count + 1
 *   and owner is unchanged. This is the classic Cardano state machine pattern.
 *
 * CounterState (datum):
 *   { count: Int, owner: ByteArray }
 *
 * CounterAction (redeemer):
 *   Increment (ConStr0) — must produce continuing output with count+1
 *   Reset (ConStr1) — owner must sign, no continuing output needed
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/state-machine.ts lock        # Lock 5 tADA with count=0
 *   npx tsx test/state-machine.ts increment   # Increment count 0→1 (continuing output)
 *   npx tsx test/state-machine.ts reset       # Reset — owner signs, reclaims funds
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
const STATE_FILE = join(__dirname, "state-machine-state.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StateMachineTestState {
  scriptAddress: string;
  scriptCbor: string;
  scriptHash: string;
  lockTxHash?: string;
  lockTxIndex?: number;
  currentCount?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[state-machine-test] ${msg}`);
}

function saveState(state: StateMachineTestState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): StateMachineTestState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
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

  // Load the state_machine counter validator — non-parameterized spend validator
  const compiledCode = loadValidatorCompiledCode("state_machine.counter.spend");

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
// Test: Lock (send 5 tADA to script with CounterState { count: 0, owner })
// ---------------------------------------------------------------------------

async function testLock() {
  const ctx = await setup();

  // Build CounterState datum: { count: 0, owner: our_key_hash }
  const datum = {
    constructor: 0,
    fields: [
      { int: 0 },                  // count
      { bytes: ctx.keyHashHex },   // owner
    ],
  };

  const lockAmount = "5000000"; // 5 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at counter script address with count=0...`);

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
  const state: StateMachineTestState = {
    scriptAddress: ctx.scriptAddress,
    scriptCbor: ctx.scriptCbor,
    scriptHash: ctx.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
    currentCount: 0,
  };
  saveState(state);
  log("State saved to test/state-machine-state.json");
}

// ---------------------------------------------------------------------------
// Test: Increment (spend UTxO, create continuing output with count+1)
// ---------------------------------------------------------------------------

async function testIncrement() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to increment — run 'lock' first");
    return;
  }

  const ctx = await setup();
  const currentCount = state.currentCount ?? 0;

  log(`Incrementing counter: ${state.lockTxHash}#${state.lockTxIndex} (count ${currentCount} → ${currentCount + 1})`);

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

  // Increment redeemer: ConStr0 (constructor index 0, no fields)
  const redeemer = { constructor: 0, fields: [] };

  // New datum with count+1, same owner
  const newDatum = {
    constructor: 0,
    fields: [
      { int: currentCount + 1 },    // count + 1
      { bytes: ctx.keyHashHex },     // same owner
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
    // address with count+1 and the same owner
    .txOut(state.scriptAddress, [
      { unit: "lovelace", quantity: continuingAmount },
    ])
    .txOutInlineDatumValue(newDatum, "JSON")
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    // Wallet UTxOs for fee coverage (script input nets to zero: 5 ADA in, 5 ADA out)
    .selectUtxosFrom(walletUtxos)
    .complete();

  txBuilder.completeSigning();
  log("Increment transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log(`Counter incremented: ${currentCount} → ${currentCount + 1}`);

  // Update state — the continuing output is at index 0 (first txOut)
  const newState: StateMachineTestState = {
    scriptAddress: state.scriptAddress,
    scriptCbor: state.scriptCbor,
    scriptHash: state.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
    currentCount: currentCount + 1,
  };
  saveState(newState);
  log("State updated — new UTxO tracks the continuing output");
}

// ---------------------------------------------------------------------------
// Test: Reset (owner signs, reclaims funds, no continuing output needed)
// ---------------------------------------------------------------------------

async function testReset() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to reset — run 'lock' first");
    return;
  }

  const ctx = await setup();
  const currentCount = state.currentCount ?? 0;

  log(`Resetting counter: ${state.lockTxHash}#${state.lockTxIndex} (count=${currentCount})`);

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

  // Reset redeemer: ConStr1 (constructor index 1, no fields)
  // Validator only checks: list.has(tx.extra_signatories, state.owner)
  const redeemer = { constructor: 1, fields: [] };

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
    // Wallet UTxOs for fee coverage
    .selectUtxosFrom(walletUtxos)
    .complete();

  txBuilder.completeSigning();
  log("Reset transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log(`Counter reset — funds reclaimed by owner (was at count=${currentCount})`);
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
    case "increment":
      await testIncrement();
      break;
    case "reset":
      await testReset();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/state-machine.ts [lock|increment|reset]");
      process.exit(1);
  }
} catch (err) {
  console.error("[state-machine-test] ERROR:", err);
  process.exit(1);
}
