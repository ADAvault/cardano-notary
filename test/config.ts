/**
 * Test configuration for preview testnet integration tests.
 *
 * Providers (any preview node with Ogmios and Kupo):
 *   - Ogmios (tx evaluation + submission): OGMIOS_URL, default http://localhost:1337
 *   - Kupo (UTxO fetcher): KUPO_URL, default http://localhost:1442
 *
 * If the node is on another machine, set the two URLs or forward the ports:
 *   ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 <user>@<your-node>
 *
 * Wallet:
 *   A funded preview testnet payment key.
 *   Copy payment.skey to test/keys/ (gitignored), or set PAYMENT_SKEY_PATH.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const config = {
  // Network
  network: "preview" as const,
  networkId: 0, // 0 = testnet, 1 = mainnet

  // Provider endpoints (from the environment, else local or tunnelled ports)
  ogmiosUrl: process.env.OGMIOS_URL || "http://localhost:1337",
  kupoUrl: process.env.KUPO_URL || "http://localhost:1442",

  // Wallet key (preview testnet only)
  paymentSkeyPath:
    process.env.PAYMENT_SKEY_PATH || join(__dirname, "keys", "payment.skey"),

  // Notary contract parameters
  notary: {
    feeLovelace: 2_000_000, // 2 tADA fee per notarization
  },

  // Blueprint
  blueprintPath: join(__dirname, "..", "contract", "plutus.json"),
};

/**
 * Load the payment signing key from the key file.
 * Supports both TextEnvelope (cardano-cli) and raw hex formats.
 */
export function loadSigningKey(): string {
  const raw = readFileSync(config.paymentSkeyPath, "utf-8");
  try {
    const envelope = JSON.parse(raw);
    // cardano-cli TextEnvelope format — cborHex contains the key
    // The CBOR wrapping is: 5820 + 32 bytes of key
    const cborHex: string = envelope.cborHex;
    // Strip the CBOR prefix (5820 = bytestring of 32 bytes)
    if (cborHex.startsWith("5820")) {
      return cborHex.slice(4);
    }
    return cborHex;
  } catch {
    // Raw hex key
    return raw.trim();
  }
}

/**
 * Load the blueprint and extract the notary validator's compiled code.
 */
export function loadNotaryCompiledCode(): string {
  return loadValidatorCompiledCode("notary.notary.mint");
}

/**
 * Load any validator's compiled code from the blueprint by title.
 * Titles follow the pattern: "module.validator_name.handler"
 * e.g. "vesting.vesting.spend", "gift_card.gift_card.mint"
 */
export function loadValidatorCompiledCode(title: string): string {
  const blueprint = JSON.parse(
    readFileSync(config.blueprintPath, "utf-8")
  );
  const validator = blueprint.validators.find(
    (v: { title: string }) => v.title === title
  );
  if (!validator) {
    throw new Error(`${title} not found in blueprint`);
  }
  return validator.compiledCode;
}
