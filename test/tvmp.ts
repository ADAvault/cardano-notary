/**
 * TVMP (Transaction-Level Validator Minting Policy) — Preview Testnet Integration Tests
 *
 * Exercises the tvmp.tvmp_vault.mint handler end-to-end on the preview testnet.
 *
 * TVMP pattern:
 *   - Mint handler runs ONCE per tx, validates transaction-level invariants
 *   - Mints exactly 1 RECEIPT token to signal validation passed
 *   - Spend handler (not tested here) checks receipt policy presence
 *
 * NOTE: The spend handler has a hardcoded `own_policy` placeholder
 * (#"aaa..."), so we ONLY test the mint handler here.
 *
 * Mint handler validation:
 *   1. Exactly 1 RECEIPT token minted (name = "RECEIPT", qty = 1)
 *   2. output_total <= input_total (no value creation)
 *
 * Redeemer: Data (Void) → ConStr0 []
 *
 * The validator is NON-PARAMETERIZED.
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/tvmp.ts mint-receipt    # Mint 1 RECEIPT token
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

// Node.js 20 lacks global WebSocket — polyfill for Ogmios provider
(globalThis as any).WebSocket = WebSocket;

import {
  MintingBlueprint,
  MeshTxBuilder,
} from "@meshsdk/core";
import { KupoProvider, OgmiosProvider } from "@meshsdk/provider";
import { AppWallet } from "@meshsdk/wallet";

import { config, loadSigningKey, loadValidatorCompiledCode } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "tvmp-state.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TvmpState {
  policyId: string;
  mintScriptCbor: string;
  mintTxHash: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[tvmp] ${msg}`);
}

function saveState(state: TvmpState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): TvmpState | null {
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
 * Build the non-parameterized MintingBlueprint for tvmp_vault.
 */
function buildBlueprint() {
  const compiledCode = loadValidatorCompiledCode("tvmp.tvmp_vault.mint");

  const mintBlueprint = new MintingBlueprint("V3");
  mintBlueprint.noParamScript(compiledCode);

  const policyId = mintBlueprint.hash;
  const mintScriptCbor = mintBlueprint.cbor;

  return {
    policyId,
    mintScriptCbor,
  };
}

// ---------------------------------------------------------------------------
// Test: Mint Receipt (mint 1 RECEIPT token)
// ---------------------------------------------------------------------------

async function testMintReceipt() {
  const ctx = await setup();
  const scripts = buildBlueprint();

  const receiptHex = Buffer.from("RECEIPT").toString("hex");
  log(`Policy ID: ${scripts.policyId}`);
  log(`Receipt token name: RECEIPT (${receiptHex})`);
  log(`Full asset: ${scripts.policyId}${receiptHex}`);

  // Redeemer: Data (Void) → ConStr0 []
  const redeemer = { constructor: 0, fields: [] };

  // Find UTxOs for tx inputs
  const utxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);

  // Find a pure-ADA UTxO for collateral
  const collateralUtxo = utxos.find(
    (u) => u.output.amount.length === 1 && u.output.amount[0].unit === "lovelace"
  );
  if (!collateralUtxo) {
    log("No pure-ADA UTxO available for collateral");
    return;
  }
  log(`Collateral UTxO: ${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`);

  log("Building mint transaction...");

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    // Mint 1 RECEIPT token
    .mintPlutusScriptV3()
    .mint("1", scripts.policyId, receiptHex)
    .mintingScript(scripts.mintScriptCbor)
    .mintRedeemerValue(redeemer, "JSON")
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Change address — minted token goes here
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(utxos)
    .complete();

  txBuilder.completeSigning();
  log("Mint transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);

  // Save state
  const state: TvmpState = {
    policyId: scripts.policyId,
    mintScriptCbor: scripts.mintScriptCbor,
    mintTxHash: submittedHash,
  };
  saveState(state);
  log("State saved to test/tvmp-state.json");
  log("Mint complete — 1 RECEIPT token minted to wallet");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2] || "mint-receipt";

try {
  switch (command) {
    case "mint-receipt":
      await testMintReceipt();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/tvmp.ts [mint-receipt]");
      process.exit(1);
  }
} catch (err) {
  console.error("[tvmp] ERROR:", err);
  process.exit(1);
}
