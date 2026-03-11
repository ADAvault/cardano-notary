/**
 * Gift Card Validator — Preview Testnet Integration Tests
 *
 * Exercises the gift_card multi-handler validator (mint + spend) end-to-end
 * on the preview testnet:
 *   1. Create: Mint a gift card NFT and lock ADA at the spend script address
 *   2. Check:  Verify the NFT exists in wallet and ADA is locked at script
 *   3. Redeem: Burn the NFT and unlock the ADA (mint + spend in one tx)
 *
 * The validator is PARAMETERIZED with (utxo_ref: OutputReference, token_name: ByteArray).
 * Both mint and spend handlers share the same parameters.
 *
 * Mint handler:
 *   CreateGiftCard (ConStr0) — consumes the one-shot UTxO, mints exactly 1 token
 *   RedeemGiftCard (ConStr1) — burns exactly 1 token
 *
 * Spend handler:
 *   Accepts any redeemer. Passes if ANY token in tx.mint has quantity < 0 (burn).
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/gift-card.ts create    # Mint gift card + lock 10 tADA
 *   npx tsx test/gift-card.ts check     # Verify NFT and locked ADA
 *   npx tsx test/gift-card.ts redeem    # Burn NFT + unlock ADA
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
const STATE_FILE = join(__dirname, "gift-card-state.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GiftCardState {
  policyId: string;
  mintScriptCbor: string;
  spendScriptCbor: string;
  spendScriptAddress: string;
  tokenNameHex: string;
  createTxHash: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[gift-card-test] ${msg}`);
}

function saveState(state: GiftCardState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): GiftCardState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
}

function strToHex(s: string): string {
  return Buffer.from(s).toString("hex");
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
 * Apply parameters to both mint and spend handlers, returning their
 * blueprint objects and derived artifacts.
 *
 * Parameters (JSON format):
 *   utxo_ref = OutputReference = ConStr0(tx_hash: ByteArray, output_index: Int)
 *   token_name = ByteArray
 */
function applyParams(txHash: string, txIndex: number, tokenNameHex: string) {
  const params = [
    {
      constructor: 0,
      fields: [{ bytes: txHash }, { int: txIndex }],
    },
    { bytes: tokenNameHex },
  ];

  // Mint handler
  const mintCompiledCode = loadValidatorCompiledCode("gift_card.gift_card.mint");
  const mintBlueprint = new MintingBlueprint("V3");
  mintBlueprint.paramScript(mintCompiledCode, params, "JSON");

  const policyId = mintBlueprint.hash;
  const mintScriptCbor = mintBlueprint.cbor;

  // Spend handler — same parameters, different compiledCode
  const spendCompiledCode = loadValidatorCompiledCode("gift_card.gift_card.spend");
  // SpendingBlueprint(version, networkId, stakeHash, isStakeScriptCredential?)
  // Empty stakeHash for enterprise-style script address (no staking credential)
  const spendBlueprint = new SpendingBlueprint("V3", 0, "");
  spendBlueprint.paramScript(spendCompiledCode, params, "JSON");

  const spendScriptCbor = spendBlueprint.cbor;
  const spendScriptAddress = spendBlueprint.address;
  const spendScriptHash = spendBlueprint.hash;

  return {
    policyId,
    mintScriptCbor,
    spendScriptCbor,
    spendScriptAddress,
    spendScriptHash,
  };
}

// ---------------------------------------------------------------------------
// Test: Create Gift Card
// ---------------------------------------------------------------------------

async function testCreate() {
  const ctx = await setup();

  const tokenNameHex = strToHex("GIFT"); // "47494654"
  log(`Token name: GIFT (${tokenNameHex})`);

  // Pick a UTxO to consume for one-shot uniqueness
  const utxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);
  const selectedUtxo = utxos[0];
  const txHash = selectedUtxo.input.txHash;
  const txIndex = selectedUtxo.input.outputIndex;
  log(`One-shot UTxO: ${txHash}#${txIndex}`);

  // Apply parameters to both handlers
  const scripts = applyParams(txHash, txIndex, tokenNameHex);
  log(`Policy ID: ${scripts.policyId}`);
  log(`Spend script address: ${scripts.spendScriptAddress}`);

  // CreateGiftCard redeemer: ConStr0 (constructor index 0, no fields)
  const createRedeemer = { constructor: 0, fields: [] };

  // Empty inline datum for the script output — Cardano requires datum for script outputs,
  // but the spend handler ignores it
  const emptyDatum = { constructor: 0, fields: [] };

  const lockAmount = "10000000"; // 10 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at script address...`);

  // Find a pure-ADA UTxO for collateral (ideally different from the one-shot UTxO)
  const collateralUtxo = utxos.find(
    (u) =>
      u.output.amount.length === 1 &&
      u.output.amount[0].unit === "lovelace" &&
      u.input.txHash !== txHash // prefer different UTxO from one-shot
  ) || selectedUtxo; // fall back to selected UTxO if no other pure-ADA available

  log(`Collateral UTxO: ${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`);

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    // Consume the one-shot UTxO (required by mint validator)
    .txIn(txHash, txIndex)
    // Mint 1 gift card NFT
    .mintPlutusScriptV3()
    .mint("1", scripts.policyId, tokenNameHex)
    .mintingScript(scripts.mintScriptCbor)
    .mintRedeemerValue(createRedeemer, "JSON")
    // Output 1: Lock ADA at the spend script address (with empty inline datum)
    .txOut(scripts.spendScriptAddress, [
      { unit: "lovelace", quantity: lockAmount },
    ])
    .txOutInlineDatumValue(emptyDatum, "JSON")
    // Output 2: Send the NFT to our wallet (the gift card receipt)
    .txOut(ctx.walletAddress, [
      { unit: "lovelace", quantity: "2000000" },
      { unit: scripts.policyId + tokenNameHex, quantity: "1" },
    ])
    // Collateral (required for Plutus scripts)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .complete();

  txBuilder.completeSigning();
  log("Create transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);

  // Save state for check/redeem steps
  const state: GiftCardState = {
    policyId: scripts.policyId,
    mintScriptCbor: scripts.mintScriptCbor,
    spendScriptCbor: scripts.spendScriptCbor,
    spendScriptAddress: scripts.spendScriptAddress,
    tokenNameHex,
    createTxHash: submittedHash,
  };
  saveState(state);
  log("State saved to test/gift-card-state.json");
}

// ---------------------------------------------------------------------------
// Test: Check Gift Card
// ---------------------------------------------------------------------------

async function testCheck() {
  const state = loadState();
  if (!state?.createTxHash) {
    log("No gift card to check — run 'create' first");
    return;
  }

  log(`Checking gift card from tx: ${state.createTxHash}`);
  log(`Policy ID: ${state.policyId}`);
  log(`Token: ${state.policyId}${state.tokenNameHex}`);
  log(`Script address: ${state.spendScriptAddress}`);

  const kupo = new KupoProvider(config.kupoUrl);

  // Check 1: Find the locked ADA at the script address
  log("\n--- Locked ADA at script address ---");
  const scriptUtxos = await kupo.fetchAddressUTxOs(state.spendScriptAddress);
  const lockedUtxo = scriptUtxos.find((u) =>
    u.input.txHash === state.createTxHash
  );

  if (lockedUtxo) {
    const amounts = lockedUtxo.output.amount
      .map((a) => `${a.quantity} ${a.unit}`)
      .join(", ");
    log(`Found locked UTxO: ${lockedUtxo.input.txHash}#${lockedUtxo.input.outputIndex}`);
    log(`  Value: ${amounts}`);
    log(`  Address: ${lockedUtxo.output.address}`);
  } else {
    log(`No locked UTxO found at script address (${scriptUtxos.length} UTxOs total)`);
    log("Tx may not be confirmed yet or Kupo not synced");
  }

  // Check 2: Find the NFT in our wallet
  log("\n--- Gift card NFT in wallet ---");
  const signingKey = loadSigningKey();
  const wallet = new AppWallet({
    networkId: config.networkId,
    fetcher: kupo,
    submitter: new OgmiosProvider(config.ogmiosUrl),
    key: { type: "cli", payment: signingKey },
  });
  await wallet.init();
  const walletAddress = wallet.getEnterpriseAddress();

  const walletUtxos = await kupo.fetchAddressUTxOs(walletAddress);
  const nftUnit = state.policyId + state.tokenNameHex;
  const nftUtxo = walletUtxos.find((u) =>
    u.output.amount.some((a) => a.unit === nftUnit)
  );

  if (nftUtxo) {
    log(`Found NFT in wallet: ${nftUtxo.input.txHash}#${nftUtxo.input.outputIndex}`);
    log(`  Token: ${nftUnit}`);
  } else {
    log("NFT not found in wallet — may not be confirmed yet");
  }

  if (lockedUtxo && nftUtxo) {
    log("\nCHECK PASSED — gift card created successfully");
  }
}

// ---------------------------------------------------------------------------
// Test: Redeem Gift Card
// ---------------------------------------------------------------------------

async function testRedeem() {
  const state = loadState();
  if (!state?.createTxHash) {
    log("No gift card to redeem — run 'create' first");
    return;
  }

  const ctx = await setup();

  log(`Redeeming gift card from tx: ${state.createTxHash}`);
  log(`Policy ID: ${state.policyId}`);
  log(`Script address: ${state.spendScriptAddress}`);

  // Find the locked UTxO at the script address
  const scriptUtxos = await ctx.kupo.fetchAddressUTxOs(state.spendScriptAddress);
  const lockedUtxo = scriptUtxos.find((u) =>
    u.input.txHash === state.createTxHash
  );

  if (!lockedUtxo) {
    log("Locked UTxO not found at script address — already redeemed or Kupo not synced");
    log(`Searched ${scriptUtxos.length} UTxOs at ${state.spendScriptAddress}`);
    return;
  }

  log(`Found locked UTxO: ${lockedUtxo.input.txHash}#${lockedUtxo.input.outputIndex}`);
  log(`  Value: ${lockedUtxo.output.amount.map((a) => `${a.quantity} ${a.unit}`).join(", ")}`);

  // Find the NFT in our wallet
  const walletUtxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);
  const nftUnit = state.policyId + state.tokenNameHex;
  const nftUtxo = walletUtxos.find((u) =>
    u.output.amount.some((a) => a.unit === nftUnit)
  );

  if (!nftUtxo) {
    log("NFT not found in wallet — cannot redeem without the gift card token");
    return;
  }

  log(`Found NFT: ${nftUtxo.input.txHash}#${nftUtxo.input.outputIndex}`);

  // Find a pure-ADA UTxO for collateral (must not be the script UTxO or NFT UTxO)
  const collateralUtxo = walletUtxos.find(
    (u) =>
      u.output.amount.length === 1 &&
      u.output.amount[0].unit === "lovelace" &&
      !(u.input.txHash === nftUtxo.input.txHash &&
        u.input.outputIndex === nftUtxo.input.outputIndex)
  );
  if (!collateralUtxo) {
    log("No pure-ADA UTxO available for collateral");
    return;
  }
  log(`Collateral UTxO: ${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`);

  // RedeemGiftCard redeemer for mint: ConStr1 (constructor index 1, no fields)
  const burnRedeemer = { constructor: 1, fields: [] };

  // Spend redeemer: the spend handler ignores the redeemer, just use Void/ConStr0
  const spendRedeemer = { constructor: 0, fields: [] };

  log("Building redeem transaction (mint burn + spend unlock)...");

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    // Spend the locked UTxO from the script address (Plutus V3 spend handler)
    .spendingPlutusScriptV3()
    .txIn(lockedUtxo.input.txHash, lockedUtxo.input.outputIndex)
    .txInScript(state.spendScriptCbor)
    .txInInlineDatumPresent()
    .txInRedeemerValue(spendRedeemer, "JSON")
    // Consume the NFT UTxO from our wallet (regular input, not a script spend)
    .txIn(nftUtxo.input.txHash, nftUtxo.input.outputIndex)
    // Burn the NFT (Plutus V3 mint handler with RedeemGiftCard redeemer)
    .mintPlutusScriptV3()
    .mint("-1", state.policyId, state.tokenNameHex)
    .mintingScript(state.mintScriptCbor)
    .mintRedeemerValue(burnRedeemer, "JSON")
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Change address — unlocked ADA + change goes here
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .complete();

  txBuilder.completeSigning();
  log("Redeem transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("Gift card redeemed — locked ADA returned to wallet, NFT burned");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2] || "create";

try {
  switch (command) {
    case "create":
      await testCreate();
      break;
    case "check":
      await testCheck();
      break;
    case "redeem":
      await testRedeem();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/gift-card.ts [create|check|redeem]");
      process.exit(1);
  }
} catch (err) {
  console.error("[gift-card-test] ERROR:", err);
  process.exit(1);
}
