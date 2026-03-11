/**
 * Withdraw Zero Pattern — Preview Testnet Integration Tests
 *
 * Exercises the withdraw-zero batch validation pattern end-to-end:
 *   1. Register: Register the staking credential for the withdrawal validator
 *   2. Lock:     Send 5 tADA to the spend script address (no datum needed)
 *   3. Batch-spend: Spend the UTxO using the batch pattern — spend validator
 *                   checks for withdrawal presence, withdrawal validator
 *                   validates the batch invariant (output <= input)
 *   4. Deregister: Deregister the staking credential to reclaim deposit
 *
 * The pattern:
 *   - batch_spend (spend validator): Parameterized by withdrawal script hash.
 *     Each UTxO does O(1) check: "is the withdrawal validator in tx.withdrawals?"
 *   - batch_validator (withdrawal validator): Non-parameterized. Runs ONCE per tx.
 *     Validates batch invariant: total output lovelace <= total input lovelace.
 *   - Withdrawal amount is 0 (no actual rewards withdrawal — hence "withdraw zero").
 *
 * Why it matters:
 *   Without this pattern, spending N UTxOs from the same script runs the spend
 *   validator N times, each doing full validation. With withdraw-zero, the spend
 *   validator just checks a boolean (O(1)), and the withdrawal validator runs once
 *   to validate everything. For batching N operations, this is O(N) → O(1).
 *
 * Staking registration:
 *   Before a withdrawal can be included in a transaction, the staking credential
 *   must be registered on-chain. In Conway era, registration is permissionless —
 *   anyone can register any credential by paying the 2 ADA deposit. No script
 *   witness is needed for registration (only for deregistration/delegation).
 *
 * Prerequisites:
 *   - SSH tunnel: ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *   - Payment signing key at test/keys/payment.skey
 *   - Kupo synced to tip on vducdn59
 *
 * Usage:
 *   npx tsx test/withdraw-zero.ts register      # Register staking credential
 *   npx tsx test/withdraw-zero.ts lock           # Lock 5 tADA at spend script
 *   npx tsx test/withdraw-zero.ts batch-spend    # Spend UTxO via withdraw-zero pattern
 *   npx tsx test/withdraw-zero.ts deregister     # Deregister staking credential
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

// Node.js 20 lacks global WebSocket — polyfill for Ogmios provider
(globalThis as any).WebSocket = WebSocket;

import {
  SpendingBlueprint,
  WithdrawalBlueprint,
  MeshTxBuilder,
} from "@meshsdk/core";
import { KupoProvider, OgmiosProvider } from "@meshsdk/provider";
import { AppWallet } from "@meshsdk/wallet";

import { config, loadSigningKey, loadValidatorCompiledCode } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "withdraw-zero-state.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WithdrawZeroState {
  // Withdrawal validator (batch_validator)
  withdrawalScriptHash: string;
  withdrawalScriptCbor: string;
  withdrawalRewardAddress: string;
  // Spend validator (batch_spend) — parameterized by withdrawal hash
  spendScriptHash: string;
  spendScriptCbor: string;
  spendScriptAddress: string;
  // Registration
  registerTxHash?: string;
  registered?: boolean;
  // Lock
  lockTxHash?: string;
  lockTxIndex?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[withdraw-zero-test] ${msg}`);
}

function saveState(state: WithdrawZeroState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): WithdrawZeroState | null {
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

  // --- Build the withdrawal validator (batch_validator) ---
  // Non-parameterized — compiledCode IS the final script
  const withdrawCompiledCode = loadValidatorCompiledCode(
    "withdraw_zero.batch_validator.withdraw"
  );
  const withdrawBlueprint = new WithdrawalBlueprint("V3", config.networkId);
  withdrawBlueprint.noParamScript(withdrawCompiledCode);

  const withdrawalScriptHash = withdrawBlueprint.hash;
  const withdrawalScriptCbor = withdrawBlueprint.cbor;
  const withdrawalRewardAddress = withdrawBlueprint.address;

  log(`Withdrawal script hash: ${withdrawalScriptHash}`);
  log(`Withdrawal reward address: ${withdrawalRewardAddress}`);

  // --- Build the spend validator (batch_spend) ---
  // Parameterized by staking_validator_hash: ByteArray
  const spendCompiledCode = loadValidatorCompiledCode(
    "withdraw_zero.batch_spend.spend"
  );
  const spendBlueprint = new SpendingBlueprint("V3", config.networkId, "");
  spendBlueprint.paramScript(
    spendCompiledCode,
    [{ bytes: withdrawalScriptHash }],
    "JSON"
  );

  const spendScriptHash = spendBlueprint.hash;
  const spendScriptCbor = spendBlueprint.cbor;
  const spendScriptAddress = spendBlueprint.address;

  log(`Spend script hash: ${spendScriptHash}`);
  log(`Spend script address: ${spendScriptAddress}`);

  return {
    ogmios,
    kupo,
    wallet,
    walletAddress,
    keyHashHex,
    signingKey,
    // Withdrawal validator
    withdrawalScriptHash,
    withdrawalScriptCbor,
    withdrawalRewardAddress,
    // Spend validator
    spendScriptHash,
    spendScriptCbor,
    spendScriptAddress,
  };
}

// ---------------------------------------------------------------------------
// Step 1: Register staking credential
// ---------------------------------------------------------------------------

async function testRegister() {
  const ctx = await setup();

  log("Registering staking credential for withdrawal validator...");
  log(`Reward address: ${ctx.withdrawalRewardAddress}`);

  // Find a pure-ADA UTxO for collateral
  const walletUtxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);
  const collateralUtxo = walletUtxos.find(
    (u) =>
      u.output.amount.length === 1 && u.output.amount[0].unit === "lovelace"
  );
  if (!collateralUtxo) {
    log("No pure-ADA UTxO available for collateral");
    return;
  }
  log(
    `Collateral UTxO: ${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`
  );

  // In Conway era, registering a staking credential is permissionless —
  // no script witness is needed. Anyone can register any credential by
  // paying the deposit (2 ADA on preview). The script is only required
  // for delegation, deregistration, and withdrawal (actions that can lose funds).
  // Therefore: no certificateScript, no redeemer, no collateral needed.

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
  });

  await txBuilder
    // Register staking credential — permissionless, just deposit
    .registerStakeCertificate(ctx.withdrawalRewardAddress)
    // Change address (registration deposit of 2 ADA will be deducted)
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(walletUtxos)
    .complete();

  txBuilder.completeSigning();
  log("Registration transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(
    `CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`
  );
  log("Staking credential registered — can now include withdrawals");

  // Save state
  const state: WithdrawZeroState = {
    withdrawalScriptHash: ctx.withdrawalScriptHash,
    withdrawalScriptCbor: ctx.withdrawalScriptCbor,
    withdrawalRewardAddress: ctx.withdrawalRewardAddress,
    spendScriptHash: ctx.spendScriptHash,
    spendScriptCbor: ctx.spendScriptCbor,
    spendScriptAddress: ctx.spendScriptAddress,
    registerTxHash: submittedHash,
    registered: true,
  };
  saveState(state);
  log("State saved to test/withdraw-zero-state.json");
}

// ---------------------------------------------------------------------------
// Step 2: Lock ADA at spend script address
// ---------------------------------------------------------------------------

async function testLock() {
  const ctx = await setup();

  // Load existing state or create fresh
  const existingState = loadState();
  if (!existingState?.registered) {
    log("WARNING: Staking credential may not be registered yet");
    log("Run 'register' first, then 'lock', then 'batch-spend'");
  }

  const lockAmount = "5000000"; // 5 tADA
  log(
    `Locking ${Number(lockAmount) / 1_000_000} tADA at spend script address...`
  );
  log(`Script address: ${ctx.spendScriptAddress}`);

  // The spend validator ignores datum — send with no inline datum.
  // But Cardano requires a datum for script outputs, so use a minimal inline datum.
  const emptyDatum = { constructor: 0, fields: [] };

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
  });

  await txBuilder
    // Output: ADA + minimal inline datum to script address
    .txOut(ctx.spendScriptAddress, [
      { unit: "lovelace", quantity: lockAmount },
    ])
    .txOutInlineDatumValue(emptyDatum, "JSON")
    // Change address
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .selectUtxosFrom(await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress))
    .complete();

  txBuilder.completeSigning();
  log("Lock transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(
    `CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`
  );

  // Save/update state
  const state: WithdrawZeroState = {
    withdrawalScriptHash: ctx.withdrawalScriptHash,
    withdrawalScriptCbor: ctx.withdrawalScriptCbor,
    withdrawalRewardAddress: ctx.withdrawalRewardAddress,
    spendScriptHash: ctx.spendScriptHash,
    spendScriptCbor: ctx.spendScriptCbor,
    spendScriptAddress: ctx.spendScriptAddress,
    registerTxHash: existingState?.registerTxHash,
    registered: existingState?.registered,
    lockTxHash: submittedHash,
    lockTxIndex: 0,
  };
  saveState(state);
  log("State saved to test/withdraw-zero-state.json");
}

// ---------------------------------------------------------------------------
// Step 3: Batch-spend via withdraw-zero pattern
// ---------------------------------------------------------------------------

async function testBatchSpend() {
  const state = loadState();
  if (!state?.lockTxHash) {
    log("No locked UTxO to spend — run 'lock' first");
    return;
  }
  if (!state?.registered) {
    log("Staking credential not registered — run 'register' first");
    return;
  }

  const ctx = await setup();

  log(`Batch-spending UTxO: ${state.lockTxHash}#${state.lockTxIndex}`);
  log(`Spend script address: ${ctx.spendScriptAddress}`);
  log(`Withdrawal reward address: ${ctx.withdrawalRewardAddress}`);

  // Find the locked UTxO at the script address
  const scriptUtxos = await ctx.kupo.fetchAddressUTxOs(ctx.spendScriptAddress);
  const lockedUtxo = scriptUtxos.find(
    (u) =>
      u.input.txHash === state.lockTxHash &&
      u.input.outputIndex === state.lockTxIndex
  );

  if (!lockedUtxo) {
    log(
      "Locked UTxO not found at script address — already spent or Kupo not synced"
    );
    log(`Searched ${scriptUtxos.length} UTxOs at ${ctx.spendScriptAddress}`);
    return;
  }

  log(
    `Found locked UTxO: ${lockedUtxo.output.amount
      .map((a) => `${a.quantity} ${a.unit}`)
      .join(", ")}`
  );

  // Find a pure-ADA UTxO for collateral (from our wallet, not the script)
  const walletUtxos = await ctx.kupo.fetchAddressUTxOs(ctx.walletAddress);
  const collateralUtxo = walletUtxos.find(
    (u) =>
      u.output.amount.length === 1 && u.output.amount[0].unit === "lovelace"
  );
  if (!collateralUtxo) {
    log("No pure-ADA UTxO available for collateral");
    return;
  }
  log(
    `Collateral UTxO: ${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`
  );

  // Redeemers — both validators accept Data, so Void/ConStr0 works
  const spendRedeemer = { constructor: 0, fields: [] };
  const withdrawRedeemer = { constructor: 0, fields: [] };

  log("Building batch-spend transaction...");
  log("  - Spend validator: checks withdrawal is present in tx.withdrawals");
  log("  - Withdrawal validator: checks output lovelace <= input lovelace");
  log("  - Withdrawal amount: 0 (withdraw-zero trick)");

  const txBuilder = new MeshTxBuilder({
    fetcher: ctx.kupo,
    submitter: ctx.ogmios,
    evaluator: ctx.ogmios,
  });

  await txBuilder
    // 1. Spend the script UTxO with Plutus V3 spend handler
    .spendingPlutusScriptV3()
    .txIn(lockedUtxo.input.txHash, lockedUtxo.input.outputIndex)
    .txInScript(ctx.spendScriptCbor)
    .txInInlineDatumPresent()
    .txInRedeemerValue(spendRedeemer, "JSON")
    // 2. Include the zero-amount withdrawal (the "withdraw zero" trick)
    .withdrawalPlutusScriptV3()
    .withdrawal(ctx.withdrawalRewardAddress, "0")
    .withdrawalScript(ctx.withdrawalScriptCbor)
    .withdrawalRedeemerValue(withdrawRedeemer, "JSON")
    // 3. Collateral (required for Plutus scripts)
    .txInCollateral(
      collateralUtxo.input.txHash,
      collateralUtxo.input.outputIndex
    )
    // Change address — unlocked ADA goes here
    .changeAddress(ctx.walletAddress)
    // Sign
    .signingKey(ctx.signingKey)
    .complete();

  txBuilder.completeSigning();
  log("Batch-spend transaction built and signed. Submitting...");

  const signedTx = txBuilder.txHex;
  const submittedHash = await ctx.ogmios.submitTx(signedTx);

  log(`SUBMITTED! Tx hash: ${submittedHash}`);
  log(
    `CardanoScan: https://preview.cardanoscan.io/transaction/${submittedHash}`
  );
  log("Batch-spend succeeded — withdraw-zero pattern validated on-chain!");
  log("");
  log("What happened:");
  log("  1. Spend validator ran for the script UTxO");
  log(
    "     -> Checked: is Script(withdrawal_hash) in tx.withdrawals? YES -> pass"
  );
  log("  2. Withdrawal validator ran ONCE for the entire transaction");
  log("     -> Checked: total output lovelace <= total input lovelace? YES -> pass");
  log("  3. Withdrawal amount was 0 — no actual rewards withdrawn");
}

// ---------------------------------------------------------------------------
// Step 4: Deregister staking credential (reclaim deposit)
// ---------------------------------------------------------------------------
//
// KNOWN LIMITATION: The batch_validator's Aiken-generated `else` handler
// defaults to `fail`, which means it cannot authorize certificate actions
// (registration/deregistration). The `withdraw` handler only fires for
// withdrawal actions in the transaction.
//
// For deregistration, the ledger invokes the `else` handler (since a
// deregistration certificate is not a withdrawal action), which fails.
//
// Production solutions:
//   1. Add an explicit `else` handler to batch_validator that allows
//      certificate actions (e.g., `else(_) { True }` or check for
//      specific certificate types)
//   2. Use a native script wrapper for the staking credential
//   3. Accept the 2 ADA deposit as a permanent cost
//
// For this test, we document the limitation rather than work around it.
// The core pattern (register → lock → batch-spend) is fully validated.

async function testDeregister() {
  const state = loadState();
  if (!state?.registered) {
    log("Staking credential not registered — nothing to deregister");
    return;
  }

  log("KNOWN LIMITATION: Cannot deregister this staking credential.");
  log("");
  log("The batch_validator's Aiken-generated 'else' handler defaults to fail.");
  log("Deregistration requires the script to authorize via a certificate action,");
  log("but only the 'withdraw' handler is implemented — 'else' catches certificates");
  log("and rejects them.");
  log("");
  log("Production fix: Add an explicit 'else' handler to batch_validator that");
  log("allows certificate actions. For example:");
  log("  validator batch_validator {");
  log("    withdraw(...) { ... }");
  log("    else(_) { True }  // Allow registration/deregistration");
  log("  }");
  log("");
  log("The 2 ADA registration deposit remains locked on-chain.");
  log("The core withdraw-zero pattern (register → lock → batch-spend) is fully validated.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2] || "register";

try {
  switch (command) {
    case "register":
      await testRegister();
      break;
    case "lock":
      await testLock();
      break;
    case "batch-spend":
      await testBatchSpend();
      break;
    case "deregister":
      await testDeregister();
      break;
    default:
      log(`Unknown command: ${command}`);
      log(
        "Usage: npx tsx test/withdraw-zero.ts [register|lock|batch-spend|deregister]"
      );
      process.exit(1);
  }
} catch (err) {
  console.error("[withdraw-zero-test] ERROR:", err);
  process.exit(1);
}
