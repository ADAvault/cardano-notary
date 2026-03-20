# Cardano Notary

Proof-of-existence notary service for Cardano. First of its kind on the chain.

## What It Does

Timestamps document hashes on the Cardano blockchain by minting a unique NFT for each notarization. The transaction's validity range — enforced by the Cardano ledger — serves as the cryptographic proof-of-existence timestamp.

**Bitcoin has OP_RETURN notary services. Cardano has nothing equivalent — until now.**

## How It Works

1. User drops a file in the browser — SHA-256 hash computed locally (file never leaves the device)
2. Browser sends the hash to the notary API with a Bearer token
3. API builds a Cardano transaction that mints a unique NFT with the hash in its datum
4. API signs and submits the transaction via Ogmios
5. The transaction's on-chain validity range proves the document existed at that time
6. A reference code (`ADV-N-260316-a7b3c`) is returned for the user's records
7. Anyone can verify by computing the file's hash and checking it against the blockchain

## Transaction Flow

```
┌──────────┐     ┌──────────────┐     ┌──────────┐     ┌──────────┐
│  Browser  │     │  Notary API  │     │  Ogmios  │     │ Cardano  │
└─────┬────┘     └──────┬───────┘     └─────┬────┘     └─────┬────┘
      │                  │                    │                │
      │ 1. Hash file     │                    │                │
      │  (client-side)   │                    │                │
      │                  │                    │                │
      │ 2. POST /notarize│                    │                │
      │  {hash, apiKey}  │                    │                │
      │─────────────────>│                    │                │
      │                  │                    │                │
      │                  │ 3. Select UTxO     │                │
      │                  │    Derive token    │                │
      │                  │    name (blake2b)  │                │
      │                  │                    │                │
      │                  │ 4. Build tx:       │                │
      │                  │  - Consume UTxO    │                │
      │                  │  - Mint NFT        │                │
      │                  │  - Inline datum    │                │
      │                  │  - Fee output      │                │
      │                  │                    │                │
      │                  │ 5. Evaluate fees   │                │
      │                  │───────────────────>│                │
      │                  │<───────────────────│                │
      │                  │                    │                │
      │                  │ 6. Sign + Submit   │                │
      │                  │───────────────────>│                │
      │                  │                    │───────────────>│
      │                  │                    │  7. Validate   │
      │                  │                    │  - Script pass │
      │                  │                    │  - Mint NFT    │
      │                  │                    │  - Add to chain│
      │                  │                    │<───────────────│
      │                  │<───────────────────│                │
      │                  │                    │                │
      │ 8. {txHash,      │                    │                │
      │  reference,      │                    │                │
      │  policyId}       │                    │                │
      │<─────────────────│                    │                │
      │                  │                    │                │

Verification (free, no auth):
      │ GET /verify/{hash}│                    │                │
      │─────────────────>│ Query Kupo for     │                │
      │                  │ matching NFT datum  │                │
      │ {verified, certs}│                    │                │
      │<─────────────────│                    │                │
```

## On-Chain Transaction Structure

What you see on Cardanoscan for each notarization:

```
Transaction
├── Input:   UTxO from operator wallet (consumed for one-shot uniqueness)
├── Mint:    +1 NFT under the notary policy ID
│            Token name = blake2b_256(serialised UTxO reference)
├── Output 1: NFT + 2 ADA → destination address
│             Inline datum: {hash, algorithm, uri?, notarizer, reference}
├── Output 2: Fee → operator wallet (cost-neutral)
├── Output 3: Change → operator wallet
├── Collateral: Pure-ADA UTxO (required for Plutus scripts)
├── Required signer: Operator key hash
└── Validity range: [slot, slot+N] (ledger-enforced timestamp)
```

## Architecture

```
Browser → adavault.com/notary (Cloudflare Pages, static)
  │
  ├─ Hash file locally (Web Crypto SHA-256)
  │
  └─ POST /api/v1/notary/notarize → API server (Express)
       │
       ├─ Build tx with MeshJS + MeshTxBuilder
       ├─ Evaluate via Ogmios (fee estimation)
       ├─ Sign with operator key (AppWallet)
       └─ Submit via Ogmios → Cardano node → on-chain
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
  reference: Option<ByteArray>,   -- Generated ref: [TICKER]-N-[YYMMDD]-[HASH]
}
```

The `reference` field replaced a free-text `description` to prevent on-chain abuse and ensure predictable fees. Format: `ADV-N-260316-a7b3c` where ADV is the operator ticker, N is the service type (Notary), and the suffix is derived from the token name.

### Performance

The contract is **O(1) per operation** — every notarization costs the same regardless of how many have been done before.

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| Notarize | O(1) | One tx, one NFT mint. Script validates current tx only. |
| Verify by hash | O(1) | Direct key lookup via chain indexer (Kupo). |
| Get certificate | O(1) | Direct key lookup by policy ID + token name. |
| List all | O(N) | Indexer query. API-level concern, not contract. |

The contract never reads historical state. No loops, no accumulation, no on-chain lookups. The 1,000,000th notarization executes identically to the 1st.

**Scaling considerations:**
- Kupo DB: ~1KB per notarization. 1M notarizations ≈ 1GB — manageable.
- API cache: refreshes every 60s. At high volumes, paginate the cache query.
- On-chain: each NFT is an independent UTxO. No contention between concurrent notarizations (UTxO locking handles this at the API level).

### Versioning

The policy ID is a hash of the compiled contract code + parameters. Any change produces a new policy ID — effectively a new version.

**To upgrade:**
1. Modify the contract or parameters
2. Compile → new policy ID
3. Deploy the new version alongside the old
4. Old notarizations remain valid forever under the old policy ID
5. The API can serve certificates from multiple policy IDs

No migration contract. No state to move. Old certificates are immutable on-chain.

**Parameter changes that create a new version:**
- `notarizer` — different operator key hash
- `fee_lovelace` — different fee amount
- Contract code changes — any logic modification

**What stays the same across versions:**
- Datum structure (backward-compatible parsing)
- Reference format (`[TICKER]-N-[YYMMDD]-[HASH]`)
- Verification flow (hash lookup is policy-agnostic)

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
| Smart contract (Aiken) | Validated — 13 tests (11 unit + 2 property-based) |
| E2E test harness | Passing — 61/61 operations on preview testnet |
| Phase 1 spec | Complete — [PHASE1-SPEC.md](docs/PHASE1-SPEC.md) |
| Credits engine spec | Complete — [CREDITS-ENGINE-SPEC.md](docs/CREDITS-ENGINE-SPEC.md) |
| API | Development — Phase A (credits engine core) |
| Verification UI | Planned — Phase D |

## Project Structure

```
cardano-notary/
├── contract/
│   └── plutus.json          -- Compiled Aiken blueprint (all validators)
├── docs/
│   ├── PHASE1-SPEC.md       -- Phase 1 service specification
│   └── CREDITS-ENGINE-SPEC.md -- Reusable API billing component spec
├── test/
│   ├── config.ts            -- Provider config, key loading, blueprint parsing
│   ├── integration.ts       -- End-to-end notarize/verify/burn on preview
│   └── keys/                -- Signing keys (gitignored)
├── tsconfig.json
└── README.md
```

## Running Integration Tests

### Prerequisites

1. Access to a Cardano preview node with Ogmios + Kupo
2. A funded preview wallet

### Setup

```bash
# SSH tunnel to your node (adjust host as needed)
ssh -N -L 1337:localhost:1337 -L 1442:localhost:1442 cardano@your-node

# Copy your payment signing key
cp /path/to/payment.skey test/keys/payment.skey

# Install dependencies
npm install
```

### Run

```bash
npm test                    # Notarize a document
npm run test:verify         # Verify an existing notarization
npm run test:burn           # Burn/revoke a notarization
```

## Documentation

- [Phase 1 Specification](docs/PHASE1-SPEC.md) — API-mediated notarization service with credits engine, implementation plan, and deployment runbook
- [Credits Engine Specification](docs/CREDITS-ENGINE-SPEC.md) — Reusable API billing component (API keys, credit balances, pluggable payment providers)

## Related

- [cardano-skill](https://github.com/ADAvault/cardano-skill) — Claude Code skill for Aiken development (includes the notary as a validated example)
- [ADAvault](https://adavault.com) — Cardano stake pool operator

## License

MIT
