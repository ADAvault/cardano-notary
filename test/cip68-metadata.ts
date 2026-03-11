/**
 * CIP-68 Rich Metadata Validator — Preview Testnet Integration Tests
 *
 * Exercises the cip68_nft multi-handler validator (mint + spend) end-to-end
 * on the preview testnet:
 *   1. Mint:   Mint a CIP-68 token pair (reference NFT + user NFT) with
 *              inline metadata datum on the reference token
 *   2. Check:  Verify the reference token UTxO at the script address and
 *              the user token in the wallet
 *   3. Update: Spend the reference token UTxO to update its metadata datum
 *              (continuing output back to script address)
 *   4. Burn:   Burn both reference and user tokens
 *
 * The validator is PARAMETERIZED with (admin: ByteArray).
 * Both mint and spend handlers share the same parameter.
 *
 * CIP68Action (shared redeemer type):
 *   Mint { token_name: ByteArray }  (ConStr0) — mint ref + user pair, admin signs
 *   UpdateMetadata                  (ConStr1) — spend handler: update metadata datum
 *   Burn { token_name: ByteArray }  (ConStr2) — burn ref + user pair, admin signs
 *
 * CIP68Datum (inline datum on reference token):
 *   { metadata: Data, version: Int, extra: Data }
 *
 * CIP-68 token name encoding:
 *   Reference token (label 222): 000de140 + base_name_hex
 *   User token (label 333):      0014df10 + base_name_hex
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/cip68-metadata.ts mint      # Mint CIP-68 token pair
 *   npx tsx test/cip68-metadata.ts check     # Verify tokens exist
 *   npx tsx test/cip68-metadata.ts update    # Update metadata on reference token
 *   npx tsx test/cip68-metadata.ts burn      # Burn both tokens
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
const STATE_FILE = join(__dirname, "cip68-metadata-state.json");

// CIP-68 label prefixes (4 bytes each, hex-encoded)
const REF_LABEL_HEX = "000de140"; // (222) reference NFT
const USR_LABEL_HEX = "0014df10"; // (333) user NFT

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CIP68State {
  policyId: string;
  mintScriptCbor: string;
  spendScriptCbor: string;
  spendScriptAddress: string;
  spendScriptHash: string;
  baseNameHex: string;
  refTokenNameHex: string;
  usrTokenNameHex: string;
  mintTxHash: string;
  updateTxHash?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[cip68-metadata-test] ${msg}`);
}

function saveState(state: CIP68State) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): CIP68State | null {
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
 * Apply the admin parameter to both mint and spend handlers,
 * returning their blueprint objects and derived artifacts.
 *
 * Parameter: admin = ByteArray (the wallet's payment key hash)
 */
function applyParams(adminKeyHash: string) {
  const param = [{ bytes: adminKeyHash }];

  // Mint handler
  const mintCompiledCode = loadValidatorCompiledCode("cip68_metadata.cip68_nft.mint");
  const mintBlueprint = new MintingBlueprint("V3");
  mintBlueprint.paramScript(mintCompiledCode, param, "JSON");

  const policyId = mintBlueprint.hash;
  const mintScriptCbor = mintBlueprint.cbor;

  // Spend handler — same parameter, different compiledCode
  const spendCompiledCode = loadValidatorCompiledCode("cip68_metadata.cip68_nft.spend");
  // SpendingBlueprint(version, networkId, stakeHash, isStakeScriptCredential?)
  // Empty stakeHash for enterprise-style script address (no staking credential)
  const spendBlueprint = new SpendingBlueprint("V3", 0, "");
  spendBlueprint.paramScript(spendCompiledCode, param, "JSON");

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
// Test: Mint CIP-68 Token Pair (reference + user)
// ---------------------------------------------------------------------------

async function testMint() {
  const ctx = await setup();
  const scripts = applyParams(ctx.keyHashHex);

  const baseName = "TestNFT";
  const baseNameHex = strToHex(baseName);
  const refTokenNameHex = REF_LABEL_HEX + baseNameHex;
  const usrTokenNameHex = USR_LABEL_HEX + baseNameHex;

  log(`Base name: ${baseName} (${baseNameHex})`);
  log(`Reference token name: ${refTokenNameHex}`);
  log(`User token name: ${usrTokenNameHex}`);
  log(`Policy ID: ${scripts.policyId}`);
  log(`Spend script address: ${scripts.spendScriptAddress}`);

  // CIP68Datum { metadata: Data, version: Int, extra: Data }
  // metadata is Data — encode as a map with CIP-25 style fields
  // Using a constructor wrapper: ConStr0 [ metadata, version, extra ]
  const metadataDatum = {
    constructor: 0,
    fields: [
      {
        // metadata — a map of key/value pairs (CIP-25 style)
        map: [
          { k: { bytes: strToHex("name") }, v: { bytes: strToHex("Test NFT") } },
          { k: { bytes: strToHex("description") }, v: { bytes: strToHex("CIP-68 integration test NFT") } },
          { k: { bytes: strToHex("image") }, v: { bytes: strToHex("ipfs://QmTestHash123") } },
        ],
      },
      { int: 1 },   // version
      { int: 0 },   // extra (Void = ConStr0? Use 0 as simple placeholder)
    ],
  };

  // Mint redeemer: Mint { token_name } = ConStr0 with 1 field (ByteArray)
  const mintRedeemer = {
    constructor: 0,
    fields: [{ bytes: baseNameHex }],
  };

  const refOutputLovelace = "2000000"; // 2 tADA — min UTxO for reference token output
  log(`Sending reference token to script address with ${Number(refOutputLovelace) / 1_000_000} tADA...`);

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

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    // Mint both tokens: 1 reference NFT + 1 user NFT
    .mintPlutusScriptV3()
    .mint("1", scripts.policyId, refTokenNameHex)
    .mintingScript(scripts.mintScriptCbor)
    .mintRedeemerValue(mintRedeemer, "JSON")
    .mintPlutusScriptV3()
    .mint("1", scripts.policyId, usrTokenNameHex)
    .mintingScript(scripts.mintScriptCbor)
    .mintRedeemerValue(mintRedeemer, "JSON")
    // Output 1: Reference token at script address with CIP68Datum inline datum
    .txOut(scripts.spendScriptAddress, [
      { unit: "lovelace", quantity: refOutputLovelace },
      { unit: scripts.policyId + refTokenNameHex, quantity: "1" },
    ])
    .txOutInlineDatumValue(metadataDatum, "JSON")
    // Output 2: User token to wallet
    .txOut(ctx.walletAddress, [
      { unit: "lovelace", quantity: "2000000" },
      { unit: scripts.policyId + usrTokenNameHex, quantity: "1" },
    ])
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — mint validator checks admin signature
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
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

  // Save state for check/update/burn steps
  const state: CIP68State = {
    policyId: scripts.policyId,
    mintScriptCbor: scripts.mintScriptCbor,
    spendScriptCbor: scripts.spendScriptCbor,
    spendScriptAddress: scripts.spendScriptAddress,
    spendScriptHash: scripts.spendScriptHash,
    baseNameHex,
    refTokenNameHex,
    usrTokenNameHex,
    mintTxHash: submittedHash,
  };
  saveState(state);
  log("State saved to test/cip68-metadata-state.json");
}

// ---------------------------------------------------------------------------
// Test: Check CIP-68 Tokens
// ---------------------------------------------------------------------------

async function testCheck() {
  const state = loadState();
  if (!state?.mintTxHash) {
    log("No CIP-68 tokens to check — run 'mint' first");
    return;
  }

  log(`Checking CIP-68 tokens from tx: ${state.mintTxHash}`);
  log(`Policy ID: ${state.policyId}`);
  log(`Reference token: ${state.policyId}${state.refTokenNameHex}`);
  log(`User token: ${state.policyId}${state.usrTokenNameHex}`);
  log(`Script address: ${state.spendScriptAddress}`);

  const kupo = new KupoProvider(config.kupoUrl);

  // Check 1: Find the reference token UTxO at the script address
  log("\n--- Reference token at script address ---");
  const scriptUtxos = await kupo.fetchAddressUTxOs(state.spendScriptAddress);

  // After an update, the reference token moves to a new UTxO — search by token, not tx hash
  const latestTxHash = state.updateTxHash || state.mintTxHash;
  const refUnit = state.policyId + state.refTokenNameHex;
  const refUtxo = scriptUtxos.find((u) =>
    u.output.amount.some((a) => a.unit === refUnit)
  );

  if (refUtxo) {
    const amounts = refUtxo.output.amount
      .map((a) => `${a.quantity} ${a.unit}`)
      .join(", ");
    log(`Found reference token UTxO: ${refUtxo.input.txHash}#${refUtxo.input.outputIndex}`);
    log(`  Value: ${amounts}`);
    log(`  Address: ${refUtxo.output.address}`);
  } else {
    log(`Reference token not found at script address (${scriptUtxos.length} UTxOs total)`);
    log("Tx may not be confirmed yet or Kupo not synced");
  }

  // Check 2: Find the user token in our wallet
  log("\n--- User token in wallet ---");
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
  const usrUnit = state.policyId + state.usrTokenNameHex;
  const usrUtxo = walletUtxos.find((u) =>
    u.output.amount.some((a) => a.unit === usrUnit)
  );

  if (usrUtxo) {
    log(`Found user token in wallet: ${usrUtxo.input.txHash}#${usrUtxo.input.outputIndex}`);
    log(`  Token: ${usrUnit}`);
  } else {
    log("User token not found in wallet — may not be confirmed yet");
  }

  if (refUtxo && usrUtxo) {
    log("\nCHECK PASSED — CIP-68 token pair minted successfully");
  }
}

// ---------------------------------------------------------------------------
// Test: Update Metadata (spend reference token UTxO, send back with new datum)
// ---------------------------------------------------------------------------

async function testUpdate() {
  const state = loadState();
  if (!state?.mintTxHash) {
    log("No CIP-68 tokens to update — run 'mint' first");
    return;
  }

  const ctx = await setup();
  const scripts = applyParams(ctx.keyHashHex);

  log(`Updating metadata for CIP-68 tokens from tx: ${state.mintTxHash}`);
  log(`Policy ID: ${state.policyId}`);
  log(`Script address: ${state.spendScriptAddress}`);

  // Find the reference token UTxO at the script address (search by token)
  const scriptUtxos = await ctx.kupo.fetchAddressUTxOs(state.spendScriptAddress);
  const refUnit = state.policyId + state.refTokenNameHex;
  const refUtxo = scriptUtxos.find((u) =>
    u.output.amount.some((a) => a.unit === refUnit)
  );

  if (!refUtxo) {
    log("Reference token UTxO not found at script address — already burned or Kupo not synced");
    log(`Searched ${scriptUtxos.length} UTxOs at ${state.spendScriptAddress}`);
    return;
  }

  log(`Found reference token UTxO: ${refUtxo.input.txHash}#${refUtxo.input.outputIndex}`);
  log(`  Value: ${refUtxo.output.amount.map((a) => `${a.quantity} ${a.unit}`).join(", ")}`);

  // Updated CIP68Datum with new metadata
  const updatedDatum = {
    constructor: 0,
    fields: [
      {
        // metadata — updated map
        map: [
          { k: { bytes: strToHex("name") }, v: { bytes: strToHex("Test NFT (Updated)") } },
          { k: { bytes: strToHex("description") }, v: { bytes: strToHex("CIP-68 metadata updated via spend handler") } },
          { k: { bytes: strToHex("image") }, v: { bytes: strToHex("ipfs://QmUpdatedHash456") } },
        ],
      },
      { int: 2 },   // version — bumped
      { int: 0 },   // extra
    ],
  };

  // UpdateMetadata redeemer: ConStr1 (constructor index 1, no fields)
  const updateRedeemer = { constructor: 1, fields: [] };

  // Find a pure-ADA UTxO for collateral (from our wallet, not the script)
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

  log("Building update transaction (spend + continuing output)...");

  // Preserve the same lovelace amount from the existing reference token UTxO
  const refLovelace = refUtxo.output.amount.find((a) => a.unit === "lovelace");
  const refLovelaceQty = refLovelace?.quantity ?? "2000000";

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    // Spend the reference token UTxO from the script address (Plutus V3 spend handler)
    .spendingPlutusScriptV3()
    .txIn(refUtxo.input.txHash, refUtxo.input.outputIndex)
    .txInScript(state.spendScriptCbor)
    .txInInlineDatumPresent()
    .txInRedeemerValue(updateRedeemer, "JSON")
    // Continuing output: reference token back to script address with updated datum
    .txOut(state.spendScriptAddress, [
      { unit: "lovelace", quantity: refLovelaceQty },
      { unit: state.policyId + state.refTokenNameHex, quantity: "1" },
    ])
    .txOutInlineDatumValue(updatedDatum, "JSON")
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — spend validator checks admin signature
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
  log("Metadata updated — reference token preserved at script address with new datum");

  // Update state with the new tx hash
  state.updateTxHash = submittedHash;
  saveState(state);
  log("State updated in test/cip68-metadata-state.json");
}

// ---------------------------------------------------------------------------
// Test: Burn CIP-68 Token Pair (reference + user)
// ---------------------------------------------------------------------------

async function testBurn() {
  const state = loadState();
  if (!state?.mintTxHash) {
    log("No CIP-68 tokens to burn — run 'mint' first");
    return;
  }

  const ctx = await setup();

  log(`Burning CIP-68 tokens from mint tx: ${state.mintTxHash}`);
  log(`Policy ID: ${state.policyId}`);
  log(`Script address: ${state.spendScriptAddress}`);

  // Find the reference token UTxO at the script address
  const scriptUtxos = await ctx.kupo.fetchAddressUTxOs(state.spendScriptAddress);
  const refUnit = state.policyId + state.refTokenNameHex;
  const refUtxo = scriptUtxos.find((u) =>
    u.output.amount.some((a) => a.unit === refUnit)
  );

  if (!refUtxo) {
    log("Reference token UTxO not found at script address — already burned or Kupo not synced");
    log(`Searched ${scriptUtxos.length} UTxOs at ${state.spendScriptAddress}`);
    return;
  }

  log(`Found reference token UTxO: ${refUtxo.input.txHash}#${refUtxo.input.outputIndex}`);
  log(`  Value: ${refUtxo.output.amount.map((a) => `${a.quantity} ${a.unit}`).join(", ")}`);

  // Find the user token in our wallet
  const walletUtxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);
  const usrUnit = state.policyId + state.usrTokenNameHex;
  const usrUtxo = walletUtxos.find((u) =>
    u.output.amount.some((a) => a.unit === usrUnit)
  );

  if (!usrUtxo) {
    log("User token not found in wallet — cannot burn without both tokens");
    return;
  }

  log(`Found user token: ${usrUtxo.input.txHash}#${usrUtxo.input.outputIndex}`);

  // Find a pure-ADA UTxO for collateral (must not be the user token UTxO)
  const collateralUtxo = walletUtxos.find(
    (u) =>
      u.output.amount.length === 1 &&
      u.output.amount[0].unit === "lovelace" &&
      !(u.input.txHash === usrUtxo.input.txHash &&
        u.input.outputIndex === usrUtxo.input.outputIndex)
  );
  if (!collateralUtxo) {
    log("No pure-ADA UTxO available for collateral");
    return;
  }
  log(`Collateral UTxO: ${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`);

  // Burn redeemer: Burn { token_name } = ConStr2 with 1 field (ByteArray)
  const burnRedeemer = {
    constructor: 2,
    fields: [{ bytes: state.baseNameHex }],
  };

  // Spend redeemer: Burn { token_name } = ConStr2 — the spend handler
  // checks this variant and skips the continuing output requirement.
  const spendRedeemer = {
    constructor: 2,
    fields: [{ bytes: state.baseNameHex }],
  };

  log("Building burn transaction (spend ref UTxO + burn both tokens)...");

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    // Spend the reference token UTxO from the script address (Plutus V3 spend handler)
    .spendingPlutusScriptV3()
    .txIn(refUtxo.input.txHash, refUtxo.input.outputIndex)
    .txInScript(state.spendScriptCbor)
    .txInInlineDatumPresent()
    .txInRedeemerValue(spendRedeemer, "JSON")
    // Consume the user token UTxO from our wallet (regular input, not a script spend)
    .txIn(usrUtxo.input.txHash, usrUtxo.input.outputIndex)
    // Burn both tokens (Plutus V3 mint handler with Burn redeemer)
    .mintPlutusScriptV3()
    .mint("-1", state.policyId, state.refTokenNameHex)
    .mintingScript(state.mintScriptCbor)
    .mintRedeemerValue(burnRedeemer, "JSON")
    .mintPlutusScriptV3()
    .mint("-1", state.policyId, state.usrTokenNameHex)
    .mintingScript(state.mintScriptCbor)
    .mintRedeemerValue(burnRedeemer, "JSON")
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — both mint and spend validators check admin signature
    .requiredSignerHash(ctx.keyHashHex)
    // Change address — unlocked ADA + change goes here
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .complete();

  txBuilder.completeSigning();
  log("Burn transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("CIP-68 token pair burned — both reference and user tokens destroyed");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2] || "mint";

try {
  switch (command) {
    case "mint":
      await testMint();
      break;
    case "check":
      await testCheck();
      break;
    case "update":
      await testUpdate();
      break;
    case "burn":
      await testBurn();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/cip68-metadata.ts [mint|check|update|burn]");
      process.exit(1);
  }
} catch (err) {
  console.error("[cip68-metadata-test] ERROR:", err);
  process.exit(1);
}
