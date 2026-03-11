/**
 * UTxO Indexer — Preview Testnet Integration Test
 *
 * Exercises the utxo_indexer.utxo_indexer.spend validator end-to-end:
 *   1. Lock: Send 5 tADA to script with TokenDatum { owner, token_count: 0 }
 *   2. Update: Spend UTxO with IndexedRedeemer, create continuing output
 *      back to script address with token_count incremented to 1
 *
 * TokenDatum (datum):
 *   { owner: ByteArray, token_count: Int } → ConStr0 [bytes, int]
 *
 * IndexedRedeemer (redeemer):
 *   { input_index: Int, output_index: Int } → ConStr0 [int, int]
 *
 * Validation:
 *   - Input at redeemer.input_index must match the spent UTxO reference
 *   - Output at redeemer.output_index must have InlineDatum with same owner
 *   - Output lovelace >= input lovelace
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/utxo-indexer.ts lock     # Lock 5 tADA with TokenDatum
 *   npx tsx test/utxo-indexer.ts update   # Update token_count 0→1 (continuing output)
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
const STATE_FILE = join(__dirname, "utxo-indexer-state.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UtxoIndexerTestState {
  scriptAddress: string;
  scriptCbor: string;
  scriptHash: string;
  lockTxHash?: string;
  lockTxIndex?: number;
  currentTokenCount?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[utxo-indexer-test] ${msg}`);
}

function saveState(state: UtxoIndexerTestState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): UtxoIndexerTestState | null {
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

  // Load the utxo_indexer validator — non-parameterized spend validator
  const compiledCode = loadValidatorCompiledCode("utxo_indexer.utxo_indexer.spend");

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
// Test: Lock (send 5 tADA to script with TokenDatum { owner, token_count: 0 })
// ---------------------------------------------------------------------------

async function testLock() {
  const ctx = await setup();

  // TokenDatum { owner: ByteArray, token_count: Int }
  const datum = {
    constructor: 0,
    fields: [
      { bytes: ctx.keyHashHex },  // owner
      { int: 0 },                 // token_count
    ],
  };

  const lockAmount = "5000000"; // 5 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at utxo_indexer script address with token_count=0...`);

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

  const state: UtxoIndexerTestState = {
    scriptAddress: ctx.scriptAddress,
    scriptCbor: ctx.scriptCbor,
    scriptHash: ctx.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
    currentTokenCount: 0,
  };
  saveState(state);
  log("State saved to test/utxo-indexer-state.json");
}

// ---------------------------------------------------------------------------
// Test: Update (spend UTxO, create continuing output with token_count+1)
// ---------------------------------------------------------------------------

async function testUpdate() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to update — run 'lock' first");
    return;
  }

  const ctx = await setup();
  const currentCount = state.currentTokenCount ?? 0;

  log(`Updating token_count: ${state.lockTxHash}#${state.lockTxIndex} (count ${currentCount} -> ${currentCount + 1})`);

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

  // New datum with token_count+1, same owner
  const newDatum = {
    constructor: 0,
    fields: [
      { bytes: ctx.keyHashHex },       // same owner
      { int: currentCount + 1 },       // token_count + 1
    ],
  };

  const continuingAmount = "5000000"; // 5 tADA — same amount back to script

  // Pick a wallet UTxO for fees and determine redeemer indices.
  // On Cardano, tx.inputs are sorted lexicographically by (txHash, outputIndex).
  // We must know the script input's position in the sorted list to set input_index.
  const feeUtxo = walletUtxos.find(
    (u) => u.output.amount.length === 1 &&
      u.output.amount[0].unit === "lovelace" &&
      (u.input.txHash !== collateralUtxo.input.txHash ||
       u.input.outputIndex !== collateralUtxo.input.outputIndex)
  ) || walletUtxos[0];

  // Determine sorted input order: script UTxO vs fee UTxO
  const scriptRef = `${lockedUtxo.input.txHash}#${lockedUtxo.input.outputIndex}`;
  const feeRef = `${feeUtxo.input.txHash}#${feeUtxo.input.outputIndex}`;
  const scriptInputIndex = scriptRef < feeRef ? 0 : 1;
  log(`Script input sorts ${scriptInputIndex === 0 ? "first" : "second"} (script: ${scriptRef.slice(0,12)}..., fee: ${feeRef.slice(0,12)}...)`);

  // IndexedRedeemer { input_index, output_index: 0 }
  // output_index 0 = our continuing output (first .txOut() call)
  const redeemer = {
    constructor: 0,
    fields: [
      { int: scriptInputIndex },  // input_index — determined by sort order
      { int: 0 },                 // output_index — continuing output is first
    ],
  };

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
    // Explicit fee input — controls the sort order so we know the input_index
    .txIn(feeUtxo.input.txHash, feeUtxo.input.outputIndex)
    // CONTINUING OUTPUT — must be at output index 0
    // Validator checks: output at output_index has same owner + lovelace >= input lovelace
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
    .complete();

  txBuilder.completeSigning();
  log("Update transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log(`Token count updated: ${currentCount} -> ${currentCount + 1}`);

  // Update state — the continuing output is at index 0 (first txOut)
  const newState: UtxoIndexerTestState = {
    scriptAddress: state.scriptAddress,
    scriptCbor: state.scriptCbor,
    scriptHash: state.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
    currentTokenCount: currentCount + 1,
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
    case "update":
      await testUpdate();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/utxo-indexer.ts [lock|update]");
      process.exit(1);
  }
} catch (err) {
  console.error("[utxo-indexer-test] ERROR:", err);
  process.exit(1);
}
