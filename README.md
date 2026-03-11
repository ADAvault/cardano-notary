# Cardano Notary

Proof-of-existence notary service for Cardano. First of its kind on the chain.

## What It Does

Timestamps document hashes on the Cardano blockchain by minting a unique NFT for each notarization. The transaction's validity range — enforced by the Cardano ledger — serves as the cryptographic proof-of-existence timestamp.

**Bitcoin has OP_RETURN notary services. Cardano has nothing equivalent — until now.**

## How It Works

1. User submits a document hash (and optional URI, description)
2. The notary operator signs and submits a transaction that mints a unique NFT
3. The NFT's datum stores the document hash, hash algorithm, URI, and notarizer identity
4. The transaction's on-chain validity range proves the document existed at that time
5. Anyone can verify by looking up the NFT and reading its datum

## Architecture

```
User → notary.adavault.com API → Build Tx → Sign → Submit → Cardano
         (or any SPO's API)

Verification: Look up NFT by policy ID → Read datum → Compare document hash
```

### Smart Contract

Parameterized Aiken mint validator. Each operator deploys with their own identity and fee:

```
validator notary(notarizer: ByteArray, fee_lovelace: Int)
```

- **One-shot NFT** — token name derived from `blake2b_256(cbor.serialise(utxo_ref))`, guaranteeing uniqueness
- **5 validation checks** — notarizer signature, UTxO consumption, single-token mint, fee payment, valid datum output
- **Burn support** — notarizer can revoke a notarization if needed

### Datum Structure

```
NotaryDatum {
  document_hash: ByteArray,       -- Hash of the document
  hash_algorithm: ByteArray,      -- "SHA-256", "BLAKE2b-256", etc.
  uri: Option<ByteArray>,         -- Where the source document lives (IPFS, URL, etc.)
  notarizer: ByteArray,           -- Who notarized it
  description: Option<ByteArray>, -- Optional context
}
```

## Advantages Over Bitcoin OP_RETURN

| Feature | Bitcoin (OP_RETURN) | Cardano Notary |
|---------|-------------------|----------------|
| Data capacity | 80 bytes | Full structured datum |
| Logic | None | Validator-enforced rules |
| Timestamp | Block time (miner-set) | Validity range (ledger-enforced) |
| Receipt | Transaction hash | Transferable NFT |
| Queryable | Raw bytes only | Typed datum via indexer |
| Revocation | Not possible | Burn the NFT |
| Fee model | Miner fee only | Configurable operator fee |
| Verification | Parse raw OP_RETURN | Read NFT datum |

## For SPOs

The contract is open source. Any SPO can:

1. Deploy their own instance with their own key and fee
2. Build their own API or use ADAvault's reference implementation
3. Offer notarization as a service to their delegators or publicly

Different parameters = different policy ID = fully independent instances.

## Status

| Component | Status |
|-----------|--------|
| Smart contract (Aiken) | Validated — 13 tests passing |
| API (notary.adavault.com) | Planned |
| Verification UI | Planned |
| Documentation | In progress |

## Project Structure

```
cardano-notary/
├── contract/        -- Aiken smart contract (planned)
├── api/             -- Express API for notarization (planned)
├── docs/            -- Design documents
└── README.md
```

## Related

- [aiken-skill](https://github.com/adavault/aiken-skill) — Claude Code skill for Aiken development (includes the notary as a validated example)
- [ADAvault](https://adavault.com) — Cardano stake pool operator

## License

MIT
