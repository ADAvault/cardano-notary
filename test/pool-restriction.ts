/**
 * Pool Restriction — Preview Testnet Integration Test
 *
 * Exercises the pool_restriction.pool_lock.spend validator end-to-end:
 *   1. Lock: Send 5 tADA to script with VaultDatum { owner, allowed_pools }
 *   2. Unlock: Spend from script with owner signature (no certificates — empty cert list passes)
 *
 * VaultDatum (datum):
 *   { owner: ByteArray, allowed_pools: List<ByteArray> }
 *   ConStr0 [bytes, list[bytes]]
 *
 * Redeemer: Data (ignored) → Void ConStr0 []
 *
 * Validation:
 *   - owner must sign (tx.extra_signatories contains datum.owner)
 *   - all delegation certificates in tx must target pools in allowed_pools
 *   - empty certificate list is valid (no delegation changes = no constraint violation)
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/pool-restriction.ts lock     # Lock 5 tADA with VaultDatum
 *   npx tsx test/pool-restriction.ts unlock   # Owner signs to reclaim funds
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
const STATE_FILE = join(__dirname, "pool-restriction-state.json");

// Fake pool IDs for testing (28 bytes each = 56 hex chars)
const FAKE_POOL_1 = "aa".repeat(28); // aaaaaa...aa (56 chars)
const FAKE_POOL_2 = "bb".repeat(28); // bbbbbb...bb (56 chars)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PoolRestrictionTestState {
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
  console.log(`[pool-restriction-test] ${msg}`);
}

function saveState(state: PoolRestrictionTestState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): PoolRestrictionTestState | null {
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

  // Load the pool_restriction pool_lock validator — non-parameterized spend validator
  const compiledCode = loadValidatorCompiledCode("pool_restriction.pool_lock.spend");

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
// Test: Lock (send 5 tADA to script with VaultDatum)
// ---------------------------------------------------------------------------

async function testLock() {
  const ctx = await setup();

  // VaultDatum { owner: ByteArray, allowed_pools: List<ByteArray> }
  const datum = {
    constructor: 0,
    fields: [
      { bytes: ctx.keyHashHex },  // owner
      {
        list: [
          { bytes: FAKE_POOL_1 },   // allowed pool 1
          { bytes: FAKE_POOL_2 },   // allowed pool 2
        ],
      },
    ],
  };

  const lockAmount = "5000000"; // 5 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at pool_lock script address...`);
  log(`Allowed pools: ${FAKE_POOL_1.slice(0, 8)}... and ${FAKE_POOL_2.slice(0, 8)}...`);

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

  const state: PoolRestrictionTestState = {
    scriptAddress: ctx.scriptAddress,
    scriptCbor: ctx.scriptCbor,
    scriptHash: ctx.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
  };
  saveState(state);
  log("State saved to test/pool-restriction-state.json");
}

// ---------------------------------------------------------------------------
// Test: Unlock (owner signs, no certificates, reclaim funds)
// ---------------------------------------------------------------------------

async function testUnlock() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to unlock — run 'lock' first");
    return;
  }

  const ctx = await setup();

  log(`Unlocking: ${state.lockTxHash}#${state.lockTxIndex}`);

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

  // Redeemer: Data (ignored by validator) — use Void/ConStr0
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
    .selectUtxosFrom(walletUtxos)
    .complete();

  txBuilder.completeSigning();
  log("Unlock transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("Pool-restricted vault unlocked — owner signed, no delegation certificates (valid)");
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
      log("Usage: npx tsx test/pool-restriction.ts [lock|unlock]");
      process.exit(1);
  }
} catch (err) {
  console.error("[pool-restriction-test] ERROR:", err);
  process.exit(1);
}
