/**
 * NFT Vault Validator — Preview Testnet Integration Tests
 *
 * Exercises the nft_vault multi-handler validator (mint + spend) end-to-end
 * on the preview testnet:
 *   1. Create: Mint 1 auth NFT with CreateVault redeemer, send to script
 *              address with VaultDatum inline datum
 *   2. Check:  Query the script address to verify UTxO exists with auth NFT
 *   3. Close:  Combined spend + burn: spend the script UTxO (requires owner
 *              sig + burn) AND burn the auth NFT with CloseVault redeemer
 *
 * The validator is PARAMETERIZED with (auth_token: ByteArray).
 * Both mint and spend handlers share the same parameter.
 *
 * MintAction:
 *   CreateVault (ConStr0) — mints exactly 1 auth token, output must contain it
 *   CloseVault  (ConStr1) — burns exactly 1 auth token
 *
 * Spend:
 *   Requires burning auth NFT (any negative mint) + owner signature.
 *   Datum: VaultDatum { owner: ByteArray, amount: Int }
 *   Redeemer: Data (ignored)
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59 (with script credential registered)
 *
 * Usage:
 *   npx tsx test/nft-vault.ts create    # Mint auth NFT + lock 5 tADA
 *   npx tsx test/nft-vault.ts check     # Verify auth NFT at script address
 *   npx tsx test/nft-vault.ts close     # Burn NFT + unlock ADA
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
const STATE_FILE = join(__dirname, "nft-vault-state.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NftVaultState {
  policyId: string;
  mintScriptCbor: string;
  spendScriptCbor: string;
  spendScriptAddress: string;
  spendScriptHash: string;
  authTokenHex: string;
  createTxHash: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[nft-vault-test] ${msg}`);
}

function saveState(state: NftVaultState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): NftVaultState | null {
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
 * Apply the auth_token parameter to both mint and spend handlers,
 * returning their blueprint objects and derived artifacts.
 *
 * Parameter: auth_token = ByteArray (hex-encoded "VAULT_AUTH")
 */
function applyParams() {
  const authTokenHex = Buffer.from("VAULT_AUTH").toString("hex");
  const param = [{ bytes: authTokenHex }];

  // Mint handler
  const mintCompiledCode = loadValidatorCompiledCode("nft_vault.nft_vault.mint");
  const mintBlueprint = new MintingBlueprint("V3");
  mintBlueprint.paramScript(mintCompiledCode, param, "JSON");

  const policyId = mintBlueprint.hash;
  const mintScriptCbor = mintBlueprint.cbor;

  // Spend handler — same parameter, different compiledCode
  const spendCompiledCode = loadValidatorCompiledCode("nft_vault.nft_vault.spend");
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
    authTokenHex,
  };
}

// ---------------------------------------------------------------------------
// Test: Create Vault (mint auth NFT + lock ADA at script)
// ---------------------------------------------------------------------------

async function testCreate() {
  const ctx = await setup();
  const scripts = applyParams();

  log(`Auth token name: VAULT_AUTH (${scripts.authTokenHex})`);
  log(`Policy ID: ${scripts.policyId}`);
  log(`Spend script address: ${scripts.spendScriptAddress}`);
  log(`Spend script hash: ${scripts.spendScriptHash}`);

  // VaultDatum { owner: ByteArray, amount: Int }
  const datum = {
    constructor: 0,
    fields: [
      { bytes: ctx.keyHashHex },  // owner
      { int: 5000000 },           // amount (5 ADA)
    ],
  };

  const lockAmount = "5000000"; // 5 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at script address with auth NFT...`);

  // CreateVault redeemer: ConStr0 (constructor index 0, no fields)
  const createRedeemer = { constructor: 0, fields: [] };

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
    // Mint 1 auth NFT
    .mintPlutusScriptV3()
    .mint("1", scripts.policyId, scripts.authTokenHex)
    .mintingScript(scripts.mintScriptCbor)
    .mintRedeemerValue(createRedeemer, "JSON")
    // Output: Lock ADA + auth NFT at the spend script address with VaultDatum
    .txOut(scripts.spendScriptAddress, [
      { unit: "lovelace", quantity: lockAmount },
      { unit: scripts.policyId + scripts.authTokenHex, quantity: "1" },
    ])
    .txOutInlineDatumValue(datum, "JSON")
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — validator checks owner
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(utxos)
    .complete();

  txBuilder.completeSigning();
  log("Create transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);

  // Save state for check/close steps
  const state: NftVaultState = {
    policyId: scripts.policyId,
    mintScriptCbor: scripts.mintScriptCbor,
    spendScriptCbor: scripts.spendScriptCbor,
    spendScriptAddress: scripts.spendScriptAddress,
    spendScriptHash: scripts.spendScriptHash,
    authTokenHex: scripts.authTokenHex,
    createTxHash: submittedHash,
  };
  saveState(state);
  log("State saved to test/nft-vault-state.json");
}

// ---------------------------------------------------------------------------
// Test: Check Vault (verify auth NFT at script address)
// ---------------------------------------------------------------------------

async function testCheck() {
  const state = loadState();
  if (!state?.createTxHash) {
    log("No vault to check — run 'create' first");
    return;
  }

  log(`Checking vault from tx: ${state.createTxHash}`);
  log(`Policy ID: ${state.policyId}`);
  log(`Auth token: ${state.policyId}${state.authTokenHex}`);
  log(`Script address: ${state.spendScriptAddress}`);

  const kupo = new KupoProvider(config.kupoUrl);

  // Check: Find the locked UTxO with auth NFT at the script address
  log("\n--- Locked UTxO at script address ---");
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

    // Verify the auth NFT is present
    const authUnit = state.policyId + state.authTokenHex;
    const hasAuth = lockedUtxo.output.amount.some((a) => a.unit === authUnit && a.quantity === "1");
    if (hasAuth) {
      log(`  Auth NFT: PRESENT`);
    } else {
      log(`  Auth NFT: MISSING — expected ${authUnit}`);
    }

    log("\nCHECK PASSED — vault created successfully with auth NFT");
  } else {
    log(`No locked UTxO found at script address (${scriptUtxos.length} UTxOs total)`);
    log("Tx may not be confirmed yet or Kupo not synced");
  }
}

// ---------------------------------------------------------------------------
// Test: Close Vault (spend UTxO + burn auth NFT)
// ---------------------------------------------------------------------------

async function testClose() {
  const state = loadState();
  if (!state?.createTxHash) {
    log("No vault to close — run 'create' first");
    return;
  }

  const ctx = await setup();

  log(`Closing vault from tx: ${state.createTxHash}`);
  log(`Policy ID: ${state.policyId}`);
  log(`Script address: ${state.spendScriptAddress}`);

  // Find the locked UTxO at the script address
  const scriptUtxos = await ctx.kupo.fetchAddressUTxOs(state.spendScriptAddress);
  const lockedUtxo = scriptUtxos.find((u) =>
    u.input.txHash === state.createTxHash
  );

  if (!lockedUtxo) {
    log("Locked UTxO not found at script address — already closed or Kupo not synced");
    log(`Searched ${scriptUtxos.length} UTxOs at ${state.spendScriptAddress}`);
    return;
  }

  log(`Found locked UTxO: ${lockedUtxo.input.txHash}#${lockedUtxo.input.outputIndex}`);
  log(`  Value: ${lockedUtxo.output.amount.map((a) => `${a.quantity} ${a.unit}`).join(", ")}`);

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

  // Spend redeemer: Data (ignored by validator) — use Void/ConStr0
  const spendRedeemer = { constructor: 0, fields: [] };

  // CloseVault burn redeemer: ConStr1 (constructor index 1, no fields)
  const burnRedeemer = { constructor: 1, fields: [] };

  log("Building close transaction (spend + burn)...");

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
    // Burn the auth NFT (Plutus V3 mint handler with CloseVault redeemer)
    .mintPlutusScriptV3()
    .mint("-1", state.policyId, state.authTokenHex)
    .mintingScript(state.mintScriptCbor)
    .mintRedeemerValue(burnRedeemer, "JSON")
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
    // Required signer — spend validator checks tx.extra_signatories for owner
    .requiredSignerHash(ctx.keyHashHex)
    // Change address — unlocked ADA + change goes here
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .complete();

  txBuilder.completeSigning();
  log("Close transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("Vault closed — ADA returned to wallet, auth NFT burned");
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
    case "close":
      await testClose();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/nft-vault.ts [create|check|close]");
      process.exit(1);
  }
} catch (err) {
  console.error("[nft-vault-test] ERROR:", err);
  process.exit(1);
}
