/**
 * Hello World Validator — Preview Testnet Integration Tests
 *
 * Exercises the hello_world.hello_world.spend validator end-to-end
 * on the preview testnet:
 *   1. Lock:   Send 5 tADA to script address with InlineDatum { owner: keyHash }
 *   2. Unlock: Spend from script with Redeemer { msg: "Hello, World!" } + owner sig
 *
 * The validator is NON-PARAMETERIZED.
 *   Datum:    { owner: ByteArray }       → ConStr0 [ bytes ]
 *   Redeemer: { msg: ByteArray }         → ConStr0 [ bytes ]
 *   Logic:    owner must sign + msg must be "Hello, World!"
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59 (with script credential registered)
 *
 * Usage:
 *   npx tsx test/hello-world.ts lock      # Lock 5 tADA at script
 *   npx tsx test/hello-world.ts unlock    # Spend from script with correct message
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
const STATE_FILE = join(__dirname, "hello-world-state.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HelloWorldState {
  spendScriptCbor: string;
  spendScriptAddress: string;
  spendScriptHash: string;
  lockTxHash: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[hello-world] ${msg}`);
}

function saveState(state: HelloWorldState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): HelloWorldState | null {
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

  return {
    ogmios,
    kupo,
    wallet,
    walletAddress,
    keyHashHex,
    signingKey,
  };
}

/**
 * Build the non-parameterized SpendingBlueprint for hello_world.
 */
function buildBlueprint() {
  const compiledCode = loadValidatorCompiledCode("hello_world.hello_world.spend");

  // SpendingBlueprint(version, networkId, stakeHash)
  // Empty stakeHash for enterprise-style script address
  const spendBlueprint = new SpendingBlueprint("V3", 0, "");
  spendBlueprint.noParamScript(compiledCode);

  const spendScriptCbor = spendBlueprint.cbor;
  const spendScriptAddress = spendBlueprint.address;
  const spendScriptHash = spendBlueprint.hash;

  return {
    spendScriptCbor,
    spendScriptAddress,
    spendScriptHash,
  };
}

// ---------------------------------------------------------------------------
// Test: Lock (send 5 tADA to script with owner datum)
// ---------------------------------------------------------------------------

async function testLock() {
  const ctx = await setup();
  const scripts = buildBlueprint();

  log(`Script address: ${scripts.spendScriptAddress}`);
  log(`Script hash: ${scripts.spendScriptHash}`);

  // Datum: { owner: ByteArray } → ConStr0 [ bytes(keyHash) ]
  const datum = {
    constructor: 0,
    fields: [
      { bytes: ctx.keyHashHex },  // owner
    ],
  };

  const lockAmount = "5000000"; // 5 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at script address...`);

  const utxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
  });

  await txBuilder
    // Output: Lock ADA at the spend script address with inline datum
    .txOut(scripts.spendScriptAddress, [
      { unit: "lovelace", quantity: lockAmount },
    ])
    .txOutInlineDatumValue(datum, "JSON")
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(utxos)
    .complete();

  txBuilder.completeSigning();
  log("Lock transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);

  // Save state for unlock step
  const state: HelloWorldState = {
    spendScriptCbor: scripts.spendScriptCbor,
    spendScriptAddress: scripts.spendScriptAddress,
    spendScriptHash: scripts.spendScriptHash,
    lockTxHash: submittedHash,
  };
  saveState(state);
  log("State saved to test/hello-world-state.json");
}

// ---------------------------------------------------------------------------
// Test: Unlock (spend from script with "Hello, World!" redeemer)
// ---------------------------------------------------------------------------

async function testUnlock() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to unlock — run 'lock' first");
    return;
  }

  const ctx = await setup();

  log(`Unlocking from tx: ${state.lockTxHash}`);
  log(`Script address: ${state.spendScriptAddress}`);

  // Find the locked UTxO at the script address
  const scriptUtxos = await ctx.kupo.fetchAddressUTxOs(state.spendScriptAddress);
  const lockedUtxo = scriptUtxos.find((u) =>
    u.input.txHash === state.lockTxHash
  );

  if (!lockedUtxo) {
    log("Locked UTxO not found at script address — not confirmed yet or Kupo not synced");
    log(`Searched ${scriptUtxos.length} UTxOs at ${state.spendScriptAddress}`);
    return;
  }

  log(`Found locked UTxO: ${lockedUtxo.input.txHash}#${lockedUtxo.input.outputIndex}`);
  log(`  Value: ${lockedUtxo.output.amount.map((a) => `${a.quantity} ${a.unit}`).join(", ")}`);

  // Find wallet UTxOs for fee coverage and collateral
  const walletUtxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);
  const collateralUtxo = walletUtxos.find(
    (u) =>
      u.output.amount.length === 1 &&
      u.output.amount[0].unit === "lovelace"
  );
  if (!collateralUtxo) {
    log("No pure-ADA UTxO available for collateral");
    return;
  }
  log(`Collateral UTxO: ${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`);

  // Redeemer: { msg: ByteArray } → ConStr0 [ bytes(hex("Hello, World!")) ]
  const helloWorldHex = Buffer.from("Hello, World!").toString("hex");
  log(`Redeemer msg hex: ${helloWorldHex}`);
  const redeemer = {
    constructor: 0,
    fields: [
      { bytes: helloWorldHex },
    ],
  };

  log("Building unlock transaction...");

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    // Spend the locked UTxO from the script address
    .spendingPlutusScriptV3()
    .txIn(lockedUtxo.input.txHash, lockedUtxo.input.outputIndex)
    .txInScript(state.spendScriptCbor)
    .txInInlineDatumPresent()
    .txInRedeemerValue(redeemer, "JSON")
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — validator checks owner in extra_signatories
    .requiredSignerHash(ctx.keyHashHex)
    // Change address — unlocked ADA goes here
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    // Provide wallet UTxOs for fee coverage
    .selectUtxosFrom(walletUtxos)
    .complete();

  txBuilder.completeSigning();
  log("Unlock transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("Unlock complete — 5 tADA returned to wallet");
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
    case "unlock":
      await testUnlock();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/hello-world.ts [lock|unlock]");
      process.exit(1);
  }
} catch (err) {
  console.error("[hello-world] ERROR:", err);
  process.exit(1);
}
