/**
 * Test configuration for preview testnet integration tests.
 *
 * Providers:
 *   - Ogmios (tx evaluation + submission): localhost:1337 via SSH tunnel
 *   - Kupo (UTxO fetcher): localhost:1442 via SSH tunnel
 *
 * SSH tunnels (run before testing):
 *   ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@vducdn59
 *
 * Wallet:
 *   Uses preview testnet wallet keys from vducdn59.
 *   Copy payment.skey to test/keys/ (gitignored).
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const config = {
  // Network
  network: "preview" as const,
  networkId: 0, // 0 = testnet, 1 = mainnet

  // Provider endpoints (via SSH tunnel to vducdn59)
  ogmiosUrl: "http://localhost:1337",
  kupoUrl: "http://localhost:1442",

  // Wallet key (preview testnet only)
  paymentSkeyPath: join(__dirname, "keys", "payment.skey"),

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
  const blueprint = JSON.parse(
    readFileSync(config.blueprintPath, "utf-8")
  );
  const validator = blueprint.validators.find(
    (v: { title: string }) => v.title === "notary.notary.mint"
  );
  if (!validator) {
    throw new Error("notary.notary.mint not found in blueprint");
  }
  return validator.compiledCode;
}
