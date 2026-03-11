/**
 * Multi-Sig Validator — Preview Testnet Integration Tests
 *
 * Exercises the multi_sig spend validator end-to-end on the preview testnet:
 *   1. Lock: Send 5 tADA to the script address with a MultiSigDatum
 *   2. Approve: Spend the UTxO with Approve redeemer + requiredSignerHash
 *
 * The validator is non-parameterized — compiledCode IS the final script.
 *
 * MultiSigDatum:
 *   signers: List<ByteArray> (list of 28-byte key hashes)
 *   threshold: Int (minimum number of signers required)
 *
 * MultiSigRedeemer:
 *   Approve (ConStr0) — no fields
 *
 * The validator counts how many of datum.signers appear in
 * tx.extra_signatories and requires the count >= datum.threshold.
 *
 * Since we only have one test wallet, we use threshold=1 with our
 * key hash as the sole signer.
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/multi-sig.ts lock      # Lock 5 tADA at multi-sig script
 *   npx tsx test/multi-sig.ts approve   # Approve — spend with threshold signers
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
const STATE_FILE = join(__dirname, "multi-sig-state.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MultiSigTestState {
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
  console.log(`[multi-sig-test] ${msg}`);
}

function saveState(state: MultiSigTestState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): MultiSigTestState | null {
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

  // Load the multi_sig validator — non-parameterized spend validator
  const compiledCode = loadValidatorCompiledCode("multi_sig.multi_sig.spend");

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

  // Build MultiSigDatum: { signers: List<ByteArray>, threshold: Int }
  // Using our key as the sole signer with threshold 1
  const datum = {
    constructor: 0,
    fields: [
      { list: [{ bytes: ctx.keyHashHex }] },  // signers
      { int: 1 },                              // threshold
    ],
  };

  const lockAmount = "5000000"; // 5 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at multi-sig script address...`);
  log(`Datum: signers=[${ctx.keyHashHex}], threshold=1`);

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
  const state: MultiSigTestState = {
    scriptAddress: ctx.scriptAddress,
    scriptCbor: ctx.scriptCbor,
    scriptHash: ctx.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
  };
  saveState(state);
  log("State saved to test/multi-sig-state.json");
}

// ---------------------------------------------------------------------------
// Test: Approve (spend with threshold signers)
// ---------------------------------------------------------------------------

async function testApprove() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to approve — run 'lock' first");
    return;
  }

  const ctx = await setup();

  log(`Approving multi-sig: ${state.lockTxHash}#${state.lockTxIndex}`);

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

  // Approve redeemer: ConStr0 (constructor index 0, no fields)
  // Validator counts signers in tx.extra_signatories that match datum.signers
  // and checks count >= datum.threshold (1 in our case).
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
    // Required signer — validator checks tx.extra_signatories against datum.signers
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .complete();

  txBuilder.completeSigning();
  log("Approve transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("Multi-sig approved — funds released to wallet");
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
    case "approve":
      await testApprove();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/multi-sig.ts [lock|approve]");
      process.exit(1);
  }
} catch (err) {
  console.error("[multi-sig-test] ERROR:", err);
  process.exit(1);
}
