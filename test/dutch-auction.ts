/**
 * Dutch Auction — Preview Testnet Integration Test
 *
 * Exercises the dutch_auction.dutch_auction.spend validator end-to-end:
 *   1. Lock: Send 5 tADA to script with AuctionDatum (seller, prices, timing)
 *   2. Cancel: Seller signs to reclaim the locked funds
 *   3. Buy: Buyer purchases at the current decayed price
 *
 * AuctionDatum (datum):
 *   { seller: ByteArray, start_price: Int, reserve_price: Int, start_time: Int, decay_per_ms: Int }
 *   ConStr0 [bytes, int, int, int, int]
 *
 * Redeemer types:
 *   Buy { current_time: Int }  -> ConStr0 [int] (current POSIX ms)
 *   Cancel                     -> ConStr1 []
 *
 * Validation:
 *   Buy: current_time anchored to validity range (is_entirely_after), seller paid >= computed price
 *   Cancel: seller must sign (tx.extra_signatories contains datum.seller)
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/dutch-auction.ts lock     # Lock 5 tADA with AuctionDatum
 *   npx tsx test/dutch-auction.ts cancel   # Seller signs to reclaim funds
 *   npx tsx test/dutch-auction.ts buy      # Buy at current decayed price
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
const STATE_FILE = join(__dirname, "dutch-auction-state.json");

// Preview testnet slot config: slot 0 = 2022-10-25T00:00:00Z = 1666656000 (Unix seconds)
const PREVIEW_SLOT_ZERO_UNIX = 1666656000;

// Auction parameters for testing
const START_PRICE = "100000000";       // 100 tADA in lovelace
const RESERVE_PRICE = "20000000";      // 20 tADA in lovelace
const DECAY_PER_MS = 10;               // 10 lovelace per ms

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DutchAuctionTestState {
  scriptAddress: string;
  scriptCbor: string;
  scriptHash: string;
  lockTxHash?: string;
  lockTxIndex?: number;
  auctionStartTime?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[dutch-auction-test] ${msg}`);
}

function saveState(state: DutchAuctionTestState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): DutchAuctionTestState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
}

/**
 * Convert current time to preview testnet slot number.
 */
function currentSlot(): number {
  return Math.floor(Date.now() / 1000) - PREVIEW_SLOT_ZERO_UNIX;
}

/**
 * Convert a preview testnet slot to POSIX milliseconds.
 */
function slotToPosixMs(slot: number): number {
  return (slot + PREVIEW_SLOT_ZERO_UNIX) * 1000;
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

  // Load the dutch_auction validator — non-parameterized spend validator
  const compiledCode = loadValidatorCompiledCode("dutch_auction.dutch_auction.spend");

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
// Test: Lock (send 5 tADA to script with AuctionDatum)
// ---------------------------------------------------------------------------

async function testLock() {
  const ctx = await setup();

  // AuctionDatum { seller, start_price, reserve_price, start_time, decay_per_ms }
  const auctionStartTime = Date.now();
  const datum = {
    constructor: 0,
    fields: [
      { bytes: ctx.keyHashHex },        // seller
      { int: Number(START_PRICE) },      // start_price (100 ADA in lovelace)
      { int: Number(RESERVE_PRICE) },    // reserve_price (20 ADA in lovelace)
      { int: auctionStartTime },         // start_time (current POSIX ms)
      { int: DECAY_PER_MS },             // decay_per_ms
    ],
  };

  const lockAmount = "5000000"; // 5 tADA
  log(`Locking ${Number(lockAmount) / 1_000_000} tADA at dutch_auction script address...`);
  log(`Auction: start=${Number(START_PRICE) / 1_000_000} tADA, reserve=${Number(RESERVE_PRICE) / 1_000_000} tADA, decay=${DECAY_PER_MS} lovelace/ms`);
  log(`Start time: ${auctionStartTime} (${new Date(auctionStartTime).toISOString()})`);

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

  const state: DutchAuctionTestState = {
    scriptAddress: ctx.scriptAddress,
    scriptCbor: ctx.scriptCbor,
    scriptHash: ctx.scriptHash,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
    auctionStartTime,
  };
  saveState(state);
  log("State saved to test/dutch-auction-state.json");
}

// ---------------------------------------------------------------------------
// Test: Cancel (seller signs to reclaim funds)
// ---------------------------------------------------------------------------

async function testCancel() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to cancel — run 'lock' first");
    return;
  }

  const ctx = await setup();

  log(`Cancelling auction: ${state.lockTxHash}#${state.lockTxIndex}`);

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

  // Cancel redeemer: ConStr1 [] (second constructor, no fields)
  const redeemer = { constructor: 1, fields: [] };

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
    // Required signer — validator checks tx.extra_signatories for seller
    .requiredSignerHash(ctx.keyHashHex)
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(walletUtxos)
    .complete();

  txBuilder.completeSigning();
  log("Cancel transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(`CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`);
  log("Dutch auction cancelled — seller signed to reclaim funds");
}

// ---------------------------------------------------------------------------
// Test: Buy (buyer purchases at current decayed price)
// ---------------------------------------------------------------------------

async function testBuy() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to buy — run 'lock' first");
    return;
  }
  if (!state.auctionStartTime) {
    log("No auction start time in state — run 'lock' again");
    return;
  }

  const ctx = await setup();

  log(`Buying from auction: ${state.lockTxHash}#${state.lockTxIndex}`);

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

  // Compute current_time and the decayed price
  // current_time is the POSIX ms we pass in the redeemer
  // The validator checks: is_entirely_after(tx.validity_range, current_time - 1)
  // This means the tx validity range lower bound must be >= current_time
  //
  // Strategy:
  //   1. current_time = now (POSIX ms)
  //   2. invalidBefore = slot corresponding to current_time (with 180s safety margin subtracted)
  //      But wait — the validity range must be ENTIRELY AFTER current_time - 1.
  //      So invalidBefore slot must convert to POSIX ms >= current_time.
  //      We use: invalidBefore = currentSlot (which maps to ~now in POSIX ms)
  //      And subtract 180s from current_time instead, so the slot is safely after it.
  //   3. invalidHereafter = currentSlot + 900 (~15 min window)

  const slot = currentSlot();

  // Set current_time to 180s in the past so the validity range (starting at ~now)
  // is entirely after current_time - 1. This accounts for preview clock skew.
  const currentTimeMs = Date.now() - 180_000;
  const invalidBeforeSlot = slot - 180;
  const invalidHereafterSlot = slot + 900;

  // Compute decayed price: price = start_price - elapsed * decay_per_ms, floored at reserve_price
  const elapsedMs = currentTimeMs - state.auctionStartTime;
  const decay = elapsedMs * DECAY_PER_MS;
  let computedPrice = Number(START_PRICE) - decay;
  if (computedPrice < Number(RESERVE_PRICE)) {
    computedPrice = Number(RESERVE_PRICE);
  }

  log(`Auction start: ${state.auctionStartTime} (${new Date(state.auctionStartTime).toISOString()})`);
  log(`Current time (redeemer): ${currentTimeMs} (${new Date(currentTimeMs).toISOString()})`);
  log(`Elapsed: ${elapsedMs} ms, Decay: ${decay} lovelace`);
  log(`Computed price: ${computedPrice} lovelace (${computedPrice / 1_000_000} tADA)`);
  log(`invalidBefore slot: ${invalidBeforeSlot}, invalidHereafter slot: ${invalidHereafterSlot}`);
  log(`invalidBefore POSIX: ${slotToPosixMs(invalidBeforeSlot)} (must be >= ${currentTimeMs})`);

  // Buy redeemer: ConStr0 [int] (first constructor = Buy, single field = current_time)
  const redeemer = {
    constructor: 0,
    fields: [
      { int: currentTimeMs },
    ],
  };

  // Seller address — enterprise address from the seller key hash (same wallet in testing)
  // The validator checks: output.address == from_verification_key(seller) && lovelace >= price
  // from_verification_key produces a mainnet/testnet enterprise address
  // Since we're on preview (testnet), we build the seller payment output to the wallet address
  const sellerPayment = String(computedPrice);

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
    // Pay the seller at least the computed price
    .txOut(ctx.walletAddress, [
      { unit: "lovelace", quantity: sellerPayment },
    ])
    // Set validity range — entire range must be after current_time - 1
    .invalidBefore(invalidBeforeSlot)
    .invalidHereafter(invalidHereafterSlot)
    // Collateral (required for Plutus scripts — must be pure ADA)
    .txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
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
  log(`Dutch auction buy succeeded — paid ${computedPrice / 1_000_000} tADA to seller`);
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
    case "cancel":
      await testCancel();
      break;
    case "buy":
      await testBuy();
      break;
    default:
      log(`Unknown command: ${command}`);
      log("Usage: npx tsx test/dutch-auction.ts [lock|cancel|buy]");
      process.exit(1);
  }
} catch (err) {
  console.error("[dutch-auction-test] ERROR:", err);
  process.exit(1);
}
