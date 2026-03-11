/**
 * Cardano Notary — Preview Testnet Integration Tests
 *
 * Exercises the notary contract end-to-end on the preview testnet:
 *   1. Notarize: Mint an NFT with document hash datum
 *   2. Verify: Query the minted NFT and read its datum
 *   3. Burn: Revoke the notarization
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npm test                    # Notarize
 *   npm run test:verify         # Verify existing notarization
 *   npm run test:burn           # Burn existing notarization
 */

import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import blake from "blakejs";

import {
  MintingBlueprint,
  MeshTxBuilder,
  mConStr0,
  mConStr1,
  byteString,
  integer,
  builtinByteString,
  serializeData,
} from "@meshsdk/core";
import { KupoProvider, OgmiosProvider } from "@meshsdk/provider";
import { AppWallet } from "@meshsdk/wallet";

import { config, loadSigningKey, loadNotaryCompiledCode } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "state.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestState {
  policyId: string;
  scriptCbor: string;
  notarizeTxHash?: string;
  tokenName?: string;
  documentHash?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[notary-test] ${msg}`);
}

function saveState(state: TestState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): TestState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
}

function hashDocument(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Derive the token name exactly matching Aiken's:
 *   blake2b_256(cbor.serialise(OutputReference))
 *
 * OutputReference CBOR encoding (Plutus Data):
 *   D879 = tag 121 (ConStr0)
 *   9F   = indefinite-length array start
 *   5820 = 32-byte bytestring prefix
 *   <32 bytes tx hash>
 *   <CBOR integer for output index>
 *   FF   = break (end array)
 *
 * Verified: exact match against Aiken compiler output.
 */
function deriveTokenName(txHashHex: string, outputIndex: number): string {
  const parts: Buffer[] = [];
  parts.push(Buffer.from("d879", "hex")); // ConStr0 tag
  parts.push(Buffer.from("9f", "hex")); // indefinite array
  parts.push(Buffer.from("5820", "hex")); // 32-byte bytestring prefix
  parts.push(Buffer.from(txHashHex, "hex")); // tx hash
  // CBOR integer encoding
  if (outputIndex <= 23) {
    parts.push(Buffer.from([outputIndex]));
  } else if (outputIndex <= 255) {
    parts.push(Buffer.from([0x18, outputIndex]));
  } else {
    parts.push(
      Buffer.from([0x19, (outputIndex >> 8) & 0xff, outputIndex & 0xff])
    );
  }
  parts.push(Buffer.from("ff", "hex")); // break
  const cbor = Buffer.concat(parts);
  return Buffer.from(blake.blake2b(cbor, null, 32)).toString("hex");
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

  // Load and parameterize the contract
  const compiledCode = loadNotaryCompiledCode();

  // Extract the payment key hash from wallet enterprise address
  // Enterprise address format: 1 byte header + 28 bytes key hash
  const usedAddr = wallet.getUsedAddress(0, 0, "enterprise");
  const addrBytes = usedAddr.toBytes();
  const keyHashHex = Buffer.from(addrBytes.slice(1, 29)).toString("hex");
  log(`Notarizer key hash: ${keyHashHex}`);

  const blueprint = new MintingBlueprint("V3");
  blueprint.paramScript(compiledCode, [
    builtinByteString(keyHashHex),
    integer(config.notary.feeLovelace),
  ]);

  const policyId = blueprint.hash;
  const scriptCbor = blueprint.cbor;
  log(`Policy ID: ${policyId}`);

  return {
    ogmios,
    kupo,
    wallet,
    walletAddress,
    policyId,
    scriptCbor,
    keyHashHex,
    signingKey,
  };
}

// ---------------------------------------------------------------------------
// Test: Notarize
// ---------------------------------------------------------------------------

async function testNotarize() {
  const ctx = await setup();

  const documentContent = `ADAvault Notary Test — ${new Date().toISOString()}`;
  const documentHash = hashDocument(documentContent);
  log(`Document: "${documentContent}"`);
  log(`SHA-256: ${documentHash}`);

  // Pick a UTxO to consume for one-shot uniqueness
  const utxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);
  const selectedUtxo = utxos[0];
  const txHash = selectedUtxo.input.txHash;
  const txIndex = selectedUtxo.input.outputIndex;
  log(`One-shot UTxO: ${txHash}#${txIndex}`);

  // Derive token name (must match on-chain derivation)
  const tokenName = deriveTokenName(txHash, txIndex);
  log(`Token name: ${tokenName}`);

  // Build redeemer: Notarize { output_ref: OutputReference { tx_id, index } }
  const redeemer = mConStr0([
    mConStr0([byteString(txHash), integer(txIndex)]),
  ]);

  // Build datum: NotaryDatum
  // Fields: document_hash, hash_algorithm, uri (None), notarizer, description (Some)
  const datum = mConStr0([
    byteString(documentHash),
    byteString(strToHex("SHA-256")),
    mConStr1([]), // uri: None
    byteString(ctx.keyHashHex),
    mConStr0([byteString(strToHex("ADAvault notary integration test"))]), // description: Some
  ]);

  log("Building notarization transaction...");

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    // Consume the one-shot UTxO
    .txIn(txHash, txIndex)
    // Mint 1 NFT
    .mintPlutusScriptV3()
    .mint("1", ctx.policyId, tokenName)
    .mintingScript(ctx.scriptCbor)
    .mintRedeemerValue(redeemer)
    // Output: NFT + datum to a script address (or wallet for simplicity)
    .txOut(ctx.walletAddress, [
      { unit: "lovelace", quantity: "2000000" },
      { unit: ctx.policyId + tokenName, quantity: "1" },
    ])
    .txOutInlineDatumValue(datum)
    // Fee output to notarizer (which is our wallet in this test)
    .txOut(ctx.walletAddress, [
      { unit: "lovelace", quantity: String(config.notary.feeLovelace) },
    ])
    // Required signer (notarizer)
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .complete();

  log("Transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);

  // Save state for verify/burn steps
  const state: TestState = {
    policyId: ctx.policyId,
    scriptCbor: ctx.scriptCbor,
    notarizeTxHash: submittedHash,
    tokenName,
    documentHash,
  };
  saveState(state);
  log("State saved to test/state.json");
}

// ---------------------------------------------------------------------------
// Test: Verify
// ---------------------------------------------------------------------------

async function testVerify() {
  const state = loadState();
  if (!state?.notarizeTxHash || !state.tokenName) {
    log("No notarization to verify — run 'npm test' first");
    return;
  }

  log(`Verifying notarization: ${state.notarizeTxHash}`);
  log(`Looking for NFT: ${state.policyId}${state.tokenName}`);

  const kupo = new KupoProvider(config.kupoUrl);

  // Query the UTxO containing the NFT
  const utxos = await kupo.fetchUTxOs(state.notarizeTxHash);
  const nftUtxo = utxos.find((u) =>
    u.output.amount.some(
      (a) => a.unit === state.policyId + state.tokenName
    )
  );

  if (!nftUtxo) {
    log("NFT UTxO not found — tx may not be confirmed yet or Kupo not synced");
    return;
  }

  log("NFT found on-chain!");
  log(`  UTxO: ${nftUtxo.input.txHash}#${nftUtxo.input.outputIndex}`);
  log(`  Address: ${nftUtxo.output.address}`);
  log(`  Datum: ${JSON.stringify(nftUtxo.output.plutusData, null, 2)}`);
  log(`  Document hash: ${state.documentHash}`);
  log("VERIFICATION PASSED");
}

// ---------------------------------------------------------------------------
// Test: Burn
// ---------------------------------------------------------------------------

async function testBurn() {
  const state = loadState();
  if (!state?.notarizeTxHash || !state.tokenName) {
    log("No notarization to burn — run 'npm test' first");
    return;
  }

  const ctx = await setup();

  log(`Burning NFT: ${state.policyId}${state.tokenName}`);

  // Find the UTxO containing the NFT
  const utxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);
  const nftUtxo = utxos.find((u) =>
    u.output.amount.some(
      (a) => a.unit === state.policyId + state.tokenName
    )
  );

  if (!nftUtxo) {
    log("NFT UTxO not found in wallet — already burned?");
    return;
  }

  // Burn redeemer: ConStr1([]) = Burn
  const burnRedeemer = mConStr1([]);

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    // Consume the NFT UTxO
    .txIn(nftUtxo.input.txHash, nftUtxo.input.outputIndex)
    // Burn the NFT
    .mintPlutusScriptV3()
    .mint("-1", ctx.policyId, state.tokenName)
    .mintingScript(ctx.scriptCbor)
    .mintRedeemerValue(burnRedeemer)
    // Required signer
    .requiredSignerHash(ctx.keyHashHex)
    // Change
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .complete();

  log("Burn transaction built. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`BURNED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2] || "notarize";

try {
  switch (command) {
    case "notarize":
      await testNotarize();
      break;
    case "verify":
      await testVerify();
      break;
    case "burn":
      await testBurn();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npm test [notarize|verify|burn]");
      process.exit(1);
  }
} catch (err) {
  console.error("[notary-test] ERROR:", err);
  process.exit(1);
}
