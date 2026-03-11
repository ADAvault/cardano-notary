/**
 * Reference Input (CIP-31) — Preview Testnet Integration Test
 *
 * Exercises two validators working together:
 *   1. price_oracle (mint) — parameterized minting policy for oracle NFT
 *   2. price_swap (spend) — reads oracle price via CIP-31 reference inputs
 *
 * Test flow:
 *   1. mint-oracle: Mint oracle NFT with OracleDatum, send to operator address
 *   2. lock-swap:   Lock 5 tADA at price_swap with SwapDatum pointing to oracle NFT
 *   3. withdraw:    Spend from swap using reference input (oracle UTxO not consumed)
 *
 * OracleDatum: { price_lovelace_per_usd: Int, last_updated: Int } -> ConStr0 [int, int]
 * SwapDatum:   { owner: ByteArray, oracle_policy: ByteArray, oracle_token_name: ByteArray }
 *              -> ConStr0 [bytes, bytes, bytes]
 *
 * OracleAction: CreateOracle -> ConStr0 [], RemoveOracle -> ConStr1 []
 * SwapRedeemer: Withdraw -> ConStr0 []
 *
 * Key CIP-31 concept: reference inputs are READ but NOT CONSUMED. The oracle UTxO
 * stays at its address — multiple dApps can read it simultaneously.
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/reference-input.ts mint-oracle   # Mint oracle NFT with price datum
 *   npx tsx test/reference-input.ts lock-swap     # Lock 5 tADA at swap script
 *   npx tsx test/reference-input.ts withdraw      # Withdraw using CIP-31 reference input
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

// Node.js 20 lacks global WebSocket — polyfill for Ogmios provider
(globalThis as any).WebSocket = WebSocket;

import {
  MintingBlueprint,
  SpendingBlueprint,
  MeshTxBuilder,
} from "@meshsdk/core";
import { KupoProvider, OgmiosProvider } from "@meshsdk/provider";
import { AppWallet } from "@meshsdk/wallet";

import { config, loadSigningKey, loadValidatorCompiledCode } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "reference-input-state.json");

const ORACLE_TOKEN_NAME = "ORACLE_NFT";
const ORACLE_TOKEN_NAME_HEX = Buffer.from(ORACLE_TOKEN_NAME).toString("hex");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RefInputTestState {
  // Oracle mint
  oraclePolicyId: string;
  oracleMintCbor: string;
  oracleTxHash?: string;
  oracleTxIndex?: number;
  // Swap spend
  swapScriptAddress: string;
  swapScriptCbor: string;
  swapScriptHash: string;
  swapLockTxHash?: string;
  swapLockTxIndex?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[reference-input-test] ${msg}`);
}

function saveState(state: RefInputTestState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): RefInputTestState | null {
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

  // Build oracle minting policy — parameterized with operator = wallet key hash
  const mintCompiledCode = loadValidatorCompiledCode("reference_input.price_oracle.mint");
  const mintBlueprint = new MintingBlueprint("V3");
  mintBlueprint.paramScript(mintCompiledCode, [{ bytes: keyHashHex }], "JSON");

  const oraclePolicyId = mintBlueprint.hash;
  const oracleMintCbor = mintBlueprint.cbor;
  log(`Oracle policy ID: ${oraclePolicyId}`);

  // Build swap spend validator — non-parameterized
  const spendCompiledCode = loadValidatorCompiledCode("reference_input.price_swap.spend");
  const spendBlueprint = new SpendingBlueprint("V3", 0, "");
  spendBlueprint.noParamScript(spendCompiledCode);

  const swapScriptHash = spendBlueprint.hash;
  const swapScriptCbor = spendBlueprint.cbor;
  const swapScriptAddress = spendBlueprint.address;
  log(`Swap script hash: ${swapScriptHash}`);
  log(`Swap script address: ${swapScriptAddress}`);

  return {
    ogmios,
    kupo,
    wallet,
    walletAddress,
    keyHashHex,
    signingKey,
    oraclePolicyId,
    oracleMintCbor,
    swapScriptHash,
    swapScriptCbor,
    swapScriptAddress,
  };
}

// ---------------------------------------------------------------------------
// Step 1: Mint Oracle NFT
// ---------------------------------------------------------------------------

async function testMintOracle() {
  const ctx = await setup();

  // OracleDatum { price_lovelace_per_usd: Int, last_updated: Int }
  const oracleDatum = {
    constructor: 0,
    fields: [
      { int: 3_000_000 },          // 3 ADA per USD
      { int: Date.now() },          // current POSIX ms
    ],
  };

  // CreateOracle redeemer (ConStr0 [])
  const redeemer = { constructor: 0, fields: [] };

  log(`Minting oracle NFT (${ORACLE_TOKEN_NAME}) with price = 3 ADA/USD...`);

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
  });

  const walletUtxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);

  await txBuilder
    // Mint oracle NFT
    .mintPlutusScriptV3()
    .mint("1", ctx.oraclePolicyId, ORACLE_TOKEN_NAME_HEX)
    .mintRedeemerValue(redeemer, "JSON")
    .mintingScript(ctx.oracleMintCbor)
    // Send oracle NFT to our wallet with oracle datum (inline)
    .txOut(ctx.walletAddress, [
      { unit: "lovelace", quantity: "5000000" },
      { unit: ctx.oraclePolicyId + ORACLE_TOKEN_NAME_HEX, quantity: "1" },
    ])
    .txOutInlineDatumValue(oracleDatum, "JSON")
    // Required signer — oracle operator
    .requiredSignerHash(ctx.keyHashHex)
    // Collateral
    .txInCollateral(
      walletUtxos.find(
        (u) => u.output.amount.length === 1 && u.output.amount[0].unit === "lovelace"
      )!.input.txHash,
      walletUtxos.find(
        (u) => u.output.amount.length === 1 && u.output.amount[0].unit === "lovelace"
      )!.input.outputIndex
    )
    .changeAddress(ctx.walletAddress)
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(walletUtxos)
    .complete();

  txBuilder.completeSigning();
  log("Oracle mint transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);

  const state: RefInputTestState = {
    oraclePolicyId: ctx.oraclePolicyId,
    oracleMintCbor: ctx.oracleMintCbor,
    oracleTxHash: submittedHash,
    oracleTxIndex: 0,  // first txOut is the oracle NFT
    swapScriptAddress: ctx.swapScriptAddress,
    swapScriptCbor: ctx.swapScriptCbor,
    swapScriptHash: ctx.swapScriptHash,
  };
  saveState(state);
  log("State saved to test/reference-input-state.json");
}

// ---------------------------------------------------------------------------
// Step 2: Lock ADA at Swap Script
// ---------------------------------------------------------------------------

async function testLockSwap() {
  const state = loadState();
  if (!state?.oracleTxHash) {
    log("No oracle NFT minted — run 'mint-oracle' first");
    return;
  }

  const ctx = await setup();

  // SwapDatum { owner, oracle_policy, oracle_token_name }
  const swapDatum = {
    constructor: 0,
    fields: [
      { bytes: ctx.keyHashHex },              // owner
      { bytes: state.oraclePolicyId },        // oracle_policy
      { bytes: ORACLE_TOKEN_NAME_HEX },       // oracle_token_name
    ],
  };

  const lockAmount = "5000000"; // 5 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at swap script...`);
  log(`SwapDatum oracle_policy: ${state.oraclePolicyId.slice(0, 16)}...`);

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
  });

  await txBuilder
    .txOut(state.swapScriptAddress, [
      { unit: "lovelace", quantity: lockAmount },
    ])
    .txOutInlineDatumValue(swapDatum, "JSON")
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

  state.swapLockTxHash = submittedHash;
  state.swapLockTxIndex = 0;
  saveState(state);
  log("State updated with swap lock tx");
}

// ---------------------------------------------------------------------------
// Step 3: Withdraw Using CIP-31 Reference Input
// ---------------------------------------------------------------------------

async function testWithdraw() {
  const state = loadState();
  if (!state?.swapLockTxHash) {
    log("No swap lock found — run 'lock-swap' first");
    return;
  }
  if (!state?.oracleTxHash) {
    log("No oracle NFT found — run 'mint-oracle' first");
    return;
  }

  const ctx = await setup();

  log(`Withdrawing from swap: ${state.swapLockTxHash}#${state.swapLockTxIndex}`);
  log(`Oracle reference input: ${state.oracleTxHash}#${state.oracleTxIndex}`);

  // Find the locked UTxO at the swap script address
  const scriptUtxos = await ctx.kupo.fetchAddressUTxOs(state.swapScriptAddress);
  const lockedUtxo = scriptUtxos.find(
    (u) =>
      u.input.txHash === state.swapLockTxHash &&
      u.input.outputIndex === state.swapLockTxIndex
  );

  if (!lockedUtxo) {
    log("Swap UTxO not found — already spent or Kupo not synced");
    log(`Searched ${scriptUtxos.length} UTxOs at ${state.swapScriptAddress}`);
    return;
  }

  log(`Found swap UTxO: ${lockedUtxo.output.amount.map((a) => `${a.quantity} ${a.unit}`).join(", ")}`);

  // Find the oracle UTxO (should still be at our wallet since it wasn't consumed)
  const walletUtxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);
  const oracleUtxo = walletUtxos.find(
    (u) =>
      u.input.txHash === state.oracleTxHash &&
      u.input.outputIndex === state.oracleTxIndex
  );

  if (!oracleUtxo) {
    log("Oracle UTxO not found at wallet — may have been spent or Kupo not synced");
    return;
  }
  log(`Found oracle UTxO: ${oracleUtxo.input.txHash}#${oracleUtxo.input.outputIndex}`);

  // Find a pure-ADA UTxO for collateral
  const collateralUtxo = walletUtxos.find(
    (u) =>
      u.output.amount.length === 1 &&
      u.output.amount[0].unit === "lovelace" &&
      (u.input.txHash !== oracleUtxo.input.txHash ||
       u.input.outputIndex !== oracleUtxo.input.outputIndex)
  );
  if (!collateralUtxo) {
    log("No pure-ADA UTxO available for collateral");
    return;
  }
  log(`Collateral UTxO: ${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`);

  // Withdraw redeemer (ConStr0 [])
  const redeemer = { constructor: 0, fields: [] };

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    // Spend the swap script UTxO
    .spendingPlutusScriptV3()
    .txIn(lockedUtxo.input.txHash, lockedUtxo.input.outputIndex)
    .txInScript(state.swapScriptCbor)
    .txInInlineDatumPresent()
    .txInRedeemerValue(redeemer, "JSON")
    // CIP-31 REFERENCE INPUT — oracle UTxO is READ, not consumed
    .readOnlyTxInReference(oracleUtxo.input.txHash, oracleUtxo.input.outputIndex)
    // Collateral
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — swap owner
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(walletUtxos)
    .complete();

  txBuilder.completeSigning();
  log("Withdraw transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("CIP-31 reference input pattern validated — oracle UTxO was read, not consumed!");
  log("The oracle UTxO remains at the wallet address for future use.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2] || "mint-oracle";

try {
  switch (command) {
    case "mint-oracle":
      await testMintOracle();
      break;
    case "lock-swap":
      await testLockSwap();
      break;
    case "withdraw":
      await testWithdraw();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/reference-input.ts [mint-oracle|lock-swap|withdraw]");
      process.exit(1);
  }
} catch (err) {
  console.error("[reference-input-test] ERROR:", err);
  process.exit(1);
}
