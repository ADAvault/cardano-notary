/**
 * Merkle Proof — Preview Testnet Integration Test
 *
 * Exercises the merkle_proof.merkle_proof.spend validator end-to-end:
 *   1. Lock: Send 5 tADA to script with MerkleDatum { merkle_root, owner }
 *   2. Update: Spend UTxO with UpdateRoot redeemer, create continuing output
 *      back to script address with new merkle_root (owner preserved)
 *
 * MerkleDatum (datum):
 *   { merkle_root: ByteArray, owner: ByteArray } -> ConStr0 [bytes, bytes]
 *
 * MerkleRedeemer (redeemer):
 *   Claim { leaf, proof }       -> ConStr0 [bytes, list]   (not tested here — Aiken unit tests cover it)
 *   UpdateRoot { new_root }     -> ConStr1 [bytes]
 *
 * UpdateRoot validation:
 *   - owner must sign (tx.extra_signatories contains datum.owner)
 *   - Continuing output at same script address with new_root and same owner
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/merkle-proof.ts lock     # Lock 5 tADA with MerkleDatum
 *   npx tsx test/merkle-proof.ts update   # Owner signs to update merkle_root (continuing output)
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
const STATE_FILE = join(__dirname, "merkle-proof-state.json");

// Placeholder Merkle roots — 32 bytes each (64 hex chars)
const INITIAL_ROOT = "aa".repeat(32);
const UPDATED_ROOT = "bb".repeat(32);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MerkleProofTestState {
  scriptAddress: string;
  scriptCbor: string;
  scriptHash: string;
  lockTxHash?: string;
  lockTxIndex?: number;
  currentRoot?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[merkle-proof-test] ${msg}`);
}

function saveState(state: MerkleProofTestState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): MerkleProofTestState | null {
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

  // Load the merkle_proof validator — non-parameterized spend validator
  const compiledCode = loadValidatorCompiledCode("merkle_proof.merkle_proof.spend");

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
// Test: Lock (send 5 tADA to script with MerkleDatum { merkle_root, owner })
// ---------------------------------------------------------------------------

async function testLock() {
  const ctx = await setup();

  // MerkleDatum { merkle_root: ByteArray, owner: ByteArray }
  const datum = {
    constructor: 0,
    fields: [
      { bytes: INITIAL_ROOT },    // merkle_root (32 bytes)
      { bytes: ctx.keyHashHex },  // owner (28-byte key hash)
    ],
  };

  const lockAmount = "5000000"; // 5 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at merkle_proof script address...`);
  log(`Merkle root: ${INITIAL_ROOT.slice(0, 16)}...`);

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

  const state: MerkleProofTestState = {
    scriptAddress: ctx.scriptAddress,
    scriptCbor: ctx.scriptCbor,
    scriptHash: ctx.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
    currentRoot: INITIAL_ROOT,
  };
  saveState(state);
  log("State saved to test/merkle-proof-state.json");
}

// ---------------------------------------------------------------------------
// Test: Update (spend UTxO with UpdateRoot, create continuing output)
// ---------------------------------------------------------------------------

async function testUpdate() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to update — run 'lock' first");
    return;
  }

  const ctx = await setup();
  const currentRoot = state.currentRoot ?? INITIAL_ROOT;
  const newRoot = currentRoot === INITIAL_ROOT ? UPDATED_ROOT : INITIAL_ROOT;

  log(`Updating merkle root: ${state.lockTxHash}#${state.lockTxIndex}`);
  log(`Root: ${currentRoot.slice(0, 16)}... -> ${newRoot.slice(0, 16)}...`);

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

  // New datum with updated merkle_root, same owner
  const newDatum = {
    constructor: 0,
    fields: [
      { bytes: newRoot },           // updated merkle_root
      { bytes: ctx.keyHashHex },    // same owner
    ],
  };

  const continuingAmount = "5000000"; // 5 tADA — same amount back to script

  // MerkleRedeemer::UpdateRoot { new_root } — constructor 1
  const redeemer = {
    constructor: 1,
    fields: [
      { bytes: newRoot },  // new_root
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
    // CONTINUING OUTPUT — validator checks for exactly one output at script address
    // with updated root and same owner
    .txOut(state.scriptAddress, [
      { unit: "lovelace", quantity: continuingAmount },
    ])
    .txOutInlineDatumValue(newDatum, "JSON")
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — validator checks tx.extra_signatories for owner
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
  log(`Merkle root updated: ${currentRoot.slice(0, 16)}... -> ${newRoot.slice(0, 16)}...`);

  // Update state — the continuing output is at index 0 (first txOut)
  const newState: MerkleProofTestState = {
    scriptAddress: state.scriptAddress,
    scriptCbor: state.scriptCbor,
    scriptHash: state.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
    currentRoot: newRoot,
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
      log("Usage: npx tsx test/merkle-proof.ts [lock|update]");
      process.exit(1);
  }
} catch (err) {
  console.error("[merkle-proof-test] ERROR:", err);
  process.exit(1);
}
