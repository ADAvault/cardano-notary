/**
 * Marketplace Validator — Preview Testnet Integration Tests
 *
 * Exercises the marketplace spend validator end-to-end on the preview testnet:
 *   1. List:   Send ADA to the script address with a ListingDatum
 *   2. Buy:    Spend the script UTxO with Buy redeemer (pays seller)
 *   3. Cancel: Spend the script UTxO with Cancel redeemer (seller reclaims)
 *
 * The validator is non-parameterized — compiledCode IS the final script.
 *
 * ListingDatum:
 *   seller: ByteArray (28-byte vkh), price: Int (lovelace),
 *   nft_policy: ByteArray (28-byte policy ID), nft_name: ByteArray
 *
 * MarketplaceRedeemer:
 *   Buy (ConStr0) — validator checks seller receives >= price in an output
 *   Cancel (ConStr1) — validator checks seller is in tx.extra_signatories
 *
 * Buy validation logic:
 *   list.any(tx.outputs, fn(o) {
 *     o.address == address.from_verification_key(d.seller)
 *       && lovelace_of(o.value) >= d.price
 *   })
 *
 * Since we only have one test wallet, we are both seller and buyer.
 * The Buy tx includes an explicit txOut paying the seller (our wallet) >= price.
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/marketplace.ts list      # List: lock 5 tADA with ListingDatum
 *   npx tsx test/marketplace.ts buy       # Buy: spend UTxO, pay seller >= price
 *   npx tsx test/marketplace.ts cancel    # Cancel: seller reclaims
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
const STATE_FILE = join(__dirname, "marketplace-state.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MarketplaceTestState {
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
  console.log(`[marketplace-test] ${msg}`);
}

function saveState(state: MarketplaceTestState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): MarketplaceTestState | null {
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

  // Load the marketplace validator — non-parameterized spend validator
  const compiledCode = loadValidatorCompiledCode("marketplace.marketplace.spend");

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
// Test: List (lock ADA at script with ListingDatum)
// ---------------------------------------------------------------------------

async function testList() {
  const ctx = await setup();

  // Dummy NFT identifiers (56 hex chars for policy, hex-encoded name)
  const nftPolicyHex = "cc".repeat(28);
  const nftNameHex = Buffer.from("TestNFT").toString("hex");

  // Build ListingDatum: { seller, price, nft_policy, nft_name }
  const datum = {
    constructor: 0,
    fields: [
      { bytes: ctx.keyHashHex },   // seller
      { int: 3_000_000 },          // price: 3 ADA
      { bytes: nftPolicyHex },     // nft_policy
      { bytes: nftNameHex },       // nft_name
    ],
  };

  const lockAmount = "5000000"; // 5 tADA
  log(`Listing: locking ${Number(lockAmount) / 1_000_000} tADA at marketplace script...`);
  log(`Seller: ${ctx.keyHashHex}`);
  log(`Price: 3 ADA (3,000,000 lovelace)`);
  log(`NFT policy: ${nftPolicyHex}`);
  log(`NFT name: TestNFT (${nftNameHex})`);

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
  log("List transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);

  // The locked UTxO will be at output index 0 (first txOut in the builder)
  const state: MarketplaceTestState = {
    scriptAddress: ctx.scriptAddress,
    scriptCbor: ctx.scriptCbor,
    scriptHash: ctx.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
  };
  saveState(state);
  log("State saved to test/marketplace-state.json");
}

// ---------------------------------------------------------------------------
// Test: Buy (spend script UTxO — must pay seller >= price)
// ---------------------------------------------------------------------------

async function testBuy() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No listed UTxO to buy — run 'list' first");
    return;
  }

  const ctx = await setup();

  log(`Buying listing: ${state.lockTxHash}#${state.lockTxIndex}`);

  // Find the listed UTxO at the script address
  const scriptUtxos = await ctx.kupo.fetchAddressUTxOs(state.scriptAddress);
  const listedUtxo = scriptUtxos.find(
    (u) =>
      u.input.txHash === state.lockTxHash &&
      u.input.outputIndex === state.lockTxIndex
  );

  if (!listedUtxo) {
    log("Listed UTxO not found at script address — already spent or Kupo not synced");
    log(`Searched ${scriptUtxos.length} UTxOs at ${state.scriptAddress}`);
    return;
  }

  log(`Found listed UTxO: ${listedUtxo.output.amount.map((a) => `${a.quantity} ${a.unit}`).join(", ")}`);

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

  // Buy redeemer: ConStr0 (constructor index 0, no fields)
  // Validator checks: an output pays seller_addr >= price.
  // seller_addr = address.from_verification_key(d.seller) — enterprise address.
  // Since we are seller and buyer, our wallet address IS the seller address.
  // We add an explicit txOut to ensure the validator sees the payment.
  const redeemer = { constructor: 0, fields: [] };

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    // Spend the script UTxO with Plutus V3
    .spendingPlutusScriptV3()
    .txIn(listedUtxo.input.txHash, listedUtxo.input.outputIndex)
    .txInScript(state.scriptCbor)
    .txInInlineDatumPresent()
    .txInRedeemerValue(redeemer, "JSON")
    // Explicit payment to seller — validator checks for this output
    // We pay 3 ADA (the listing price) to our wallet address (the seller)
    .txOut(ctx.walletAddress, [{ unit: "lovelace", quantity: "3000000" }])
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — not strictly needed for Buy, but good practice
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(walletUtxos)
    .complete();

  txBuilder.completeSigning();
  log("Buy transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("Purchase complete — seller paid >= 3 ADA");

  // Clear lockTxHash since UTxO is spent
  state.lockTxHash = undefined;
  state.lockTxIndex = undefined;
  saveState(state);
}

// ---------------------------------------------------------------------------
// Test: Cancel (seller reclaims — requires seller signature)
// ---------------------------------------------------------------------------

async function testCancel() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No listed UTxO to cancel — run 'list' first");
    return;
  }

  const ctx = await setup();

  log(`Cancelling listing: ${state.lockTxHash}#${state.lockTxIndex}`);

  // Find the listed UTxO at the script address
  const scriptUtxos = await ctx.kupo.fetchAddressUTxOs(state.scriptAddress);
  const listedUtxo = scriptUtxos.find(
    (u) =>
      u.input.txHash === state.lockTxHash &&
      u.input.outputIndex === state.lockTxIndex
  );

  if (!listedUtxo) {
    log("Listed UTxO not found at script address — already spent or Kupo not synced");
    log(`Searched ${scriptUtxos.length} UTxOs at ${state.scriptAddress}`);
    return;
  }

  log(`Found listed UTxO: ${listedUtxo.output.amount.map((a) => `${a.quantity} ${a.unit}`).join(", ")}`);

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

  // Cancel redeemer: ConStr1 (constructor index 1, no fields)
  // Validator checks: seller is in tx.extra_signatories
  const redeemer = { constructor: 1, fields: [] };

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    // Spend the script UTxO with Plutus V3
    .spendingPlutusScriptV3()
    .txIn(listedUtxo.input.txHash, listedUtxo.input.outputIndex)
    .txInScript(state.scriptCbor)
    .txInInlineDatumPresent()
    .txInRedeemerValue(redeemer, "JSON")
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — validator checks tx.extra_signatories for seller
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .complete();

  txBuilder.completeSigning();
  log("Cancel transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("Listing cancelled — funds returned to seller");

  // Clear lockTxHash since UTxO is spent
  state.lockTxHash = undefined;
  state.lockTxIndex = undefined;
  saveState(state);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2] || "list";

try {
  switch (command) {
    case "list":
      await testList();
      break;
    case "buy":
      await testBuy();
      break;
    case "cancel":
      await testCancel();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/marketplace.ts [list|buy|cancel]");
      process.exit(1);
  }
} catch (err) {
  console.error("[marketplace-test] ERROR:", err);
  process.exit(1);
}
