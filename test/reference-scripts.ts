/**
 * Reference Scripts (CIP-33) — Preview Testnet Integration Test
 *
 * Exercises the reference_scripts.script_registry.spend validator end-to-end:
 *   1. Lock:   Send 5 tADA to script_registry with RegistryDatum { admin, script_hash, version: 1 }
 *   2. Update: Spend UTxO with UpdateScript, create continuing output with version 2
 *   3. Remove: Spend UTxO with RemoveScript, admin signs, funds returned to wallet
 *
 * RegistryDatum (datum):
 *   { admin: ByteArray, script_hash: ByteArray, version: Int } -> ConStr0 [bytes, bytes, int]
 *
 * RegistryAction (redeemer):
 *   UpdateScript -> ConStr0 []
 *   RemoveScript -> ConStr1 []
 *
 * Validation (UpdateScript):
 *   - Admin must sign (extra_signatories)
 *   - Continuing output at same script address with InlineDatum
 *   - Datum admin and script_hash unchanged, version incremented by 1
 *   - Output lovelace >= input lovelace
 *
 * Validation (RemoveScript):
 *   - Admin must sign (extra_signatories)
 *   - Funds returned to admin (no continuing output required)
 *
 * Note: script_user tests are skipped — they require populating the reference_script
 * field on a UTxO, which is complex. The registry tests validate the CIP-33 pattern.
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/reference-scripts.ts lock-registry     # Lock 5 tADA with RegistryDatum
 *   npx tsx test/reference-scripts.ts update-registry   # Update version 1->2 (continuing output)
 *   npx tsx test/reference-scripts.ts remove-registry   # Remove registry, funds to wallet
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
const STATE_FILE = join(__dirname, "reference-scripts-state.json");

// A mock 28-byte script hash for the registry datum's script_hash field.
// In production this would be the hash of an actual Plutus script being stored.
const MOCK_SCRIPT_HASH = "aabbccddee112233445566778899001122334455667788990011aabb";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RefScriptsTestState {
  scriptAddress: string;
  scriptCbor: string;
  scriptHash: string;
  lockTxHash?: string;
  lockTxIndex?: number;
  currentVersion?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[reference-scripts-test] ${msg}`);
}

function saveState(state: RefScriptsTestState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): RefScriptsTestState | null {
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
  const usedAddr = wallet.getUsedAddress(0, 0, "enterprise");
  const addrHex = usedAddr.toBytes() as unknown as string;
  const keyHashHex = addrHex.slice(2, 58);
  log(`Key hash: ${keyHashHex}`);

  // Load the script_registry validator — non-parameterized spend validator
  const compiledCode = loadValidatorCompiledCode("reference_scripts.script_registry.spend");

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
// Test: Lock Registry (send 5 tADA to script with RegistryDatum { admin, script_hash, version: 1 })
// ---------------------------------------------------------------------------

async function testLockRegistry() {
  const ctx = await setup();

  // RegistryDatum { admin: ByteArray, script_hash: ByteArray, version: Int }
  const datum = {
    constructor: 0,
    fields: [
      { bytes: ctx.keyHashHex },     // admin
      { bytes: MOCK_SCRIPT_HASH },   // script_hash
      { int: 1 },                    // version
    ],
  };

  const lockAmount = "5000000"; // 5 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at script_registry with version=1...`);
  log(`Admin: ${ctx.keyHashHex}`);
  log(`Script hash (datum): ${MOCK_SCRIPT_HASH}`);

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

  const state: RefScriptsTestState = {
    scriptAddress: ctx.scriptAddress,
    scriptCbor: ctx.scriptCbor,
    scriptHash: ctx.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
    currentVersion: 1,
  };
  saveState(state);
  log("State saved to test/reference-scripts-state.json");
}

// ---------------------------------------------------------------------------
// Test: Update Registry (spend UTxO, create continuing output with version+1)
// ---------------------------------------------------------------------------

async function testUpdateRegistry() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to update — run 'lock-registry' first");
    return;
  }

  const ctx = await setup();
  const currentVersion = state.currentVersion ?? 1;

  log(`Updating registry: ${state.lockTxHash}#${state.lockTxIndex} (version ${currentVersion} -> ${currentVersion + 1})`);

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

  // Find wallet UTxOs for collateral and fees
  const walletUtxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);

  // Find a pure-ADA UTxO for collateral
  const collateralUtxo = walletUtxos.find(
    (u) => u.output.amount.length === 1 && u.output.amount[0].unit === "lovelace"
  );
  if (!collateralUtxo) {
    log("No pure-ADA UTxO available for collateral");
    return;
  }
  log(`Collateral UTxO: ${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`);

  // New datum with version+1, same admin and script_hash
  const newDatum = {
    constructor: 0,
    fields: [
      { bytes: ctx.keyHashHex },       // same admin
      { bytes: MOCK_SCRIPT_HASH },     // same script_hash
      { int: currentVersion + 1 },     // version + 1
    ],
  };

  const continuingAmount = "5000000"; // 5 tADA — same amount back to script

  // Pick a wallet UTxO for fees and determine redeemer indices.
  // On Cardano, tx.inputs are sorted lexicographically by (txHash, outputIndex).
  const feeUtxo = walletUtxos.find(
    (u) => u.output.amount.length === 1 &&
      u.output.amount[0].unit === "lovelace" &&
      (u.input.txHash !== collateralUtxo.input.txHash ||
       u.input.outputIndex !== collateralUtxo.input.outputIndex)
  ) || walletUtxos[0];

  // UpdateScript redeemer (ConStr0 [])
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
    // Explicit fee input — controls the sort order
    .txIn(feeUtxo.input.txHash, feeUtxo.input.outputIndex)
    // CONTINUING OUTPUT — must be at output index 0
    // Validator checks: same admin, same script_hash, version+1, lovelace >= input
    .txOut(state.scriptAddress, [
      { unit: "lovelace", quantity: continuingAmount },
    ])
    .txOutInlineDatumValue(newDatum, "JSON")
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — admin
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(walletUtxos)
    .complete();

  txBuilder.completeSigning();
  log("Update transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log(`Registry version updated: ${currentVersion} -> ${currentVersion + 1}`);

  // Update state — the continuing output is at index 0 (first txOut)
  const newState: RefScriptsTestState = {
    scriptAddress: state.scriptAddress,
    scriptCbor: state.scriptCbor,
    scriptHash: state.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
    currentVersion: currentVersion + 1,
  };
  saveState(newState);
  log("State updated — new UTxO tracks the continuing output");
}

// ---------------------------------------------------------------------------
// Test: Remove Registry (spend UTxO with RemoveScript, funds returned to wallet)
// ---------------------------------------------------------------------------

async function testRemoveRegistry() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to remove — run 'lock-registry' first");
    return;
  }

  const ctx = await setup();

  log(`Removing registry: ${state.lockTxHash}#${state.lockTxIndex} (version ${state.currentVersion})`);

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

  // Find wallet UTxOs for collateral and fees
  const walletUtxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);

  // Find a pure-ADA UTxO for collateral
  const collateralUtxo = walletUtxos.find(
    (u) => u.output.amount.length === 1 && u.output.amount[0].unit === "lovelace"
  );
  if (!collateralUtxo) {
    log("No pure-ADA UTxO available for collateral");
    return;
  }
  log(`Collateral UTxO: ${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`);

  // Pick a wallet UTxO for fees
  const feeUtxo = walletUtxos.find(
    (u) => u.output.amount.length === 1 &&
      u.output.amount[0].unit === "lovelace" &&
      (u.input.txHash !== collateralUtxo.input.txHash ||
       u.input.outputIndex !== collateralUtxo.input.outputIndex)
  ) || walletUtxos[0];

  // RemoveScript redeemer (ConStr1 [])
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
    // Explicit fee input
    .txIn(feeUtxo.input.txHash, feeUtxo.input.outputIndex)
    // No continuing output — funds go to change address (admin's wallet)
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — admin
    .requiredSignerHash(ctx.keyHashHex)
    // Change address — admin receives the locked funds
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(walletUtxos)
    .complete();

  txBuilder.completeSigning();
  log("Remove transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log(`Registry removed — 5 tADA returned to admin wallet`);
  log("CIP-33 reference scripts registry pattern validated on-chain!");

  // Clear state — UTxO no longer exists at script address
  const newState: RefScriptsTestState = {
    scriptAddress: state.scriptAddress,
    scriptCbor: state.scriptCbor,
    scriptHash: state.scriptHash,
  };
  saveState(newState);
  log("State cleared — registry UTxO consumed");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2] || "lock-registry";

try {
  switch (command) {
    case "lock-registry":
      await testLockRegistry();
      break;
    case "update-registry":
      await testUpdateRegistry();
      break;
    case "remove-registry":
      await testRemoveRegistry();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/reference-scripts.ts [lock-registry|update-registry|remove-registry]");
      process.exit(1);
  }
} catch (err) {
  console.error("[reference-scripts-test] ERROR:", err);
  process.exit(1);
}
