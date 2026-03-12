# Notary Service — Phase 1 Specification

Detailed specification for Phase 1: API-mediated notarization with verification UI.

**Date:** 2026-03-12
**Status:** Draft — awaiting CxO approval
**Depends on:**
- Existing notary contract (validated on preview, 13 Aiken tests + E2E)
- Credits engine (see [CREDITS-ENGINE-SPEC.md](CREDITS-ENGINE-SPEC.md))

---

## Table of Contents

1. [Scope](#1-scope)
2. [User Journeys](#2-user-journeys)
3. [Smart Contract Interface](#3-smart-contract-interface)
4. [API Specification](#4-api-specification)
5. [Frontend Specification](#5-frontend-specification)
6. [Infrastructure](#6-infrastructure)
7. [State & Storage](#7-state--storage)
8. [Error Handling](#8-error-handling)
9. [Security](#9-security)
10. [Testing Plan](#10-testing-plan)
11. [Open Items](#11-open-items)

---

## 1. Scope

### In Scope (Phase 1)

- **Credits engine** — API key auth, credit balances, metered endpoints (see [CREDITS-ENGINE-SPEC.md](CREDITS-ENGINE-SPEC.md))
- Operator-signed notarization via API (Tier 1)
- Document hash verification via API and web UI
- Shareable certificate pages
- Burn/revocation by operator
- Optional user-specified NFT destination address
- Reference script deployment (CIP-33)
- Preview testnet first, then preprod, then mainnet

### Out of Scope (Phase 2+)

- Wallet-direct notarization (CIP-30 browser signing)
- Batch/Merkle notarization
- Delegator pricing perks
- Stripe / ADA on-chain / x402 payment providers (credits engine Phases 2-4)
- Self-service API key creation
- File upload (we never touch the document, only its hash)

---

## 2. User Journeys

### Journey 1: Notarize a Document

**Actor:** External user (developer, business, individual)
**Goal:** Get cryptographic proof that a document existed at a specific time

```
User                          Frontend                         API                            Cardano
 │                              │                               │                               │
 │  1. Navigate to /notary      │                               │                               │
 │─────────────────────────────>│                               │                               │
 │                              │  Show hash submission form    │                               │
 │<─────────────────────────────│                               │                               │
 │                              │                               │                               │
 │  2. Drag+drop file           │                               │                               │
 │  (or paste hash manually)    │                               │                               │
 │─────────────────────────────>│                               │                               │
 │                              │  3. Hash file in browser      │                               │
 │                              │     (SHA-256, client-side)    │                               │
 │                              │  4. Show hash + confirm       │                               │
 │<─────────────────────────────│                               │                               │
 │                              │                               │                               │
 │  5. Click "Notarize"         │                               │                               │
 │  (+ optional URI, desc,      │                               │                               │
 │    destination address)      │                               │                               │
 │─────────────────────────────>│                               │                               │
 │                              │  6. POST /notary/notarize     │                               │
 │                              │─────────────────────────────>│                               │
 │                              │                               │  7. Build tx (mint NFT)       │
 │                              │                               │  8. Sign with operator key    │
 │                              │                               │  9. Submit to node            │
 │                              │                               │─────────────────────────────>│
 │                              │                               │                               │
 │                              │                               │  10. Return tx hash           │
 │                              │  11. Return tx hash + status  │<──────────────────────────────│
 │                              │<─────────────────────────────│                               │
 │                              │                               │                               │
 │  12. Show "Submitted"        │                               │                               │
 │  + tx hash + certificate     │                               │                               │
 │  link                        │                               │                               │
 │<─────────────────────────────│                               │                               │
```

**Key points:**
- File never leaves the browser — only the hash is sent to the API
- Hash is computed client-side using Web Crypto API (SHA-256). BLAKE2b-256 hashes must be computed externally and pasted manually (Web Crypto does not support BLAKE2b)
- User can paste a pre-computed hash instead of dropping a file
- Optional: URI (where document lives, e.g. IPFS CID), description, destination address
- Response includes a certificate URL for sharing

**Error states:**
- Missing or invalid API key → 401
- Insufficient credits → 402 with balance details
- Insufficient operator funds → 503 with retry-after
- Duplicate hash → 409 with existing certificate link (advisory, not blocked — same hash from different notarizers is legitimate)
- Invalid hash format → 400
- Rate limited → 429

### Journey 2: Verify a Document

**Actor:** Anyone (no account needed)
**Goal:** Confirm a document was notarized and when

```
User                          Frontend                         API                            Kupo
 │                              │                               │                               │
 │  1. Navigate to              │                               │                               │
 │     /notary/verify           │                               │                               │
 │─────────────────────────────>│                               │                               │
 │                              │  Show verification form       │                               │
 │<─────────────────────────────│                               │                               │
 │                              │                               │                               │
 │  2. Drop file or paste hash  │                               │                               │
 │─────────────────────────────>│                               │                               │
 │                              │  3. Hash file (if file)       │                               │
 │                              │  4. GET /notary/verify/:hash  │                               │
 │                              │─────────────────────────────>│                               │
 │                              │                               │  5. Query UTxOs by policy     │
 │                              │                               │─────────────────────────────>│
 │                              │                               │  6. Filter for matching       │
 │                              │                               │     document_hash in datum    │
 │                              │                               │                               │
 │                              │  7. Return match + metadata   │                               │
 │                              │<─────────────────────────────│                               │
 │                              │                               │                               │
 │  8. Show result:             │                               │                               │
 │     - Verified / Not found   │                               │                               │
 │     - Timestamp (slot→time)  │                               │                               │
 │     - Notarizer identity     │                               │                               │
 │     - Certificate link       │                               │                               │
 │     - CardanoScan link       │                               │                               │
 │<─────────────────────────────│                               │                               │
```

**Key points:**
- Verification is free, no authentication required
- API searches all known notarizations for matching document_hash
- Multiple matches possible (same hash notarized by different operators)
- Response includes slot number, converted to human-readable timestamp
- "Not found" doesn't mean fake — could be notarized by a different operator instance

### Journey 3: View Certificate

**Actor:** Anyone with the certificate URL
**Goal:** See proof details in a shareable format

```
User                          Frontend                         API
 │                              │                               │
 │  1. Open /notary/            │                               │
 │     certificate/:policyId/   │                               │
 │     :tokenName               │                               │
 │─────────────────────────────>│                               │
 │                              │  2. GET /notary/certificate/  │
 │                              │     :policyId/:tokenName      │
 │                              │─────────────────────────────>│
 │                              │                               │
 │                              │  3. Return NFT datum +        │
 │                              │     tx metadata               │
 │                              │<─────────────────────────────│
 │                              │                               │
 │  4. Render certificate:      │                               │
 │     - Document hash          │                               │
 │     - Hash algorithm         │                               │
 │     - Timestamp              │                               │
 │     - Notarizer ID           │                               │
 │     - URI (if provided)      │                               │
 │     - Description            │                               │
 │     - Policy ID              │                               │
 │     - Tx hash + explorer     │
 │     - Burn status            │                               │
 │<─────────────────────────────│                               │
```

**Key points:**
- Certificate is a bookmarkable, shareable URL. The page shell is pre-built (Astro), but content is loaded dynamically via a React island that fetches from the API
- Shows revocation status (active vs revoked)
- Includes external verification link (CardanoScan)
- Machine-readable: `Accept: application/json` returns raw data

### Journey 4: Revoke a Notarization

**Actor:** Admin only (authenticated with `adv_admin_` key)
**Goal:** Burn the NFT on-chain to invalidate a notarization

```
Admin                          API                            Cardano
 │                              │                               │
 │  1. DELETE /notary/          │                               │
 │     :policyId/:tokenName     │                               │
 │     (admin API key)          │                               │
 │─────────────────────────────>│                               │
 │                              │  2. Find NFT UTxO             │
 │                              │  3. Build burn tx             │
 │                              │  4. Sign + submit             │
 │                              │─────────────────────────────>│
 │                              │                               │
 │  5. Return burn tx hash      │                               │
 │<─────────────────────────────│                               │
```

**Key points:**
- Admin-only action — requires API key with `notary:burn` permission (typically `adv_admin_` key)
- Burns the NFT on-chain (quantity -1), making it permanently unspendable
- Certificate page shows "Revoked" status after burn
- Verification still returns the record but marked as revoked

**Terminology:** "Revoke" is the business action (invalidating the notarization). "Burn" is the on-chain mechanism (destroying the NFT token). The API performs a revocation, which is implemented via a burn transaction.

---

## 3. Smart Contract Interface

### Contract Source

`/home/rezi/products/vault/validators/notary.ak` — no changes needed for Phase 1.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `notarizer` | `ByteArray` (28 bytes) | VK hash of the authorized notarizer |
| `fee_lovelace` | `Int` | Minimum lovelace fee per notarization |

Different parameter values = different policy ID = independent instances.

**Migration note:** Changing `fee_lovelace` after deployment creates a new policy ID (a new contract instance). Existing NFTs remain valid under the original policy. The verify endpoint MUST search across all known policy IDs. Document the active policy list in API configuration.

### Datum

```
NotaryDatum {
  document_hash: ByteArray,        -- SHA-256 or BLAKE2b-256 digest
  hash_algorithm: ByteArray,       -- "SHA-256" or "BLAKE2b-256"
  uri: Option<ByteArray>,          -- Source location (IPFS, URL, etc.)
  notarizer: ByteArray,            -- VK hash of who notarized
  description: Option<ByteArray>,  -- Free-text context
}
```

### Redeemers

| Redeemer | Fields | Checks |
|----------|--------|--------|
| `Notarize` | `output_ref: OutputReference` | Notarizer signed, UTxO consumed, exactly 1 token minted, fee paid, datum output exists |
| `Burn` | (none) | Exactly 1 token burned, notarizer signed |

### Token Name Derivation

`blake2b_256(cbor.serialise(output_ref))` — deterministic from the consumed UTxO, guaranteeing uniqueness.

### NFT Destination

The validator checks that *some* output carries the NFT with a valid inline `NotaryDatum`. It does **not** enforce which address. This means:

- **Default (Phase 1):** NFT goes to operator's registry address
- **Optional:** API caller specifies a destination → NFT goes there instead
- **No contract change required**

---

## 4. API Specification

All endpoints on `api.adavault.com` (and `api2.adavault.com` for DR).

### 4.1 Notarize

```
POST /api/v1/notary/notarize
Authorization: Bearer adv_live_...
Content-Type: application/json
```

**Authentication:** Requires API key. Credits deducted on success (see [credits engine](CREDITS-ENGINE-SPEC.md)).

**Request:**

```json
{
  "document_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "hash_algorithm": "SHA-256",
  "uri": "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  "description": "Annual audit report 2026",
  "destination": "addr1qx..."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `document_hash` | string | Yes | Hex-encoded hash, 64 chars (both SHA-256 and BLAKE2b-256 produce 32-byte / 64 hex char digests). Normalised to lowercase on receipt. |
| `hash_algorithm` | string | No | `"SHA-256"` (default) or `"BLAKE2b-256"` |
| `uri` | string | No | Source document location |
| `description` | string | No | Free-text context (max 256 bytes on-chain) |
| `destination` | string | No | Bech32 address for NFT output. Default: notarizer registry address |
| `allow_duplicate` | boolean | No | If `true`, bypass 409 duplicate check. Default: `false` |

**Response (202 Accepted):**

```json
{
  "tx_hash": "48ae388c24e5252120b4d015abc9786714288b73489a99dfb1fc3b35229ff307",
  "policy_id": "a1b2c3d4...",
  "token_name": "e5f6a7b8...",
  "certificate_url": "/notary/certificate/a1b2c3d4.../e5f6a7b8...",
  "explorer_url": "https://cardanoscan.io/transaction/48ae388c...",
  "status": "submitted",
  "estimated_confirmation_seconds": 20
}
```

**Status:** 202 because the transaction is submitted but not yet confirmed. Certificate URL is valid immediately (shows "pending" until confirmed).

**Confirmation tracking:** The client polls `GET /api/v1/notary/certificate/:policyId/:tokenName` until it returns 200 with `"status": "active"`. Typical confirmation time is ~20 seconds on mainnet. If the transaction fails on-chain (not confirmed within 5 minutes), the API auto-refunds the reserved credits and the certificate endpoint returns `"status": "failed"`. See §7.4 for the auto-refund mechanism.

**Error responses:**

| Status | Condition | Body |
|--------|-----------|------|
| 400 | Invalid hash format, bad address, description too long | `{ "error": "...", "details": "..." }` |
| 401 | Missing or invalid API key | `{ "error": "unauthorized" }` |
| 402 | Insufficient credits | `{ "error": "insufficient_credits", "available": 0, "required": 2000, "unit": "millicredits" }` |
| 409 | Identical hash already notarized by this operator | `{ "error": "duplicate", "existing_certificate": "/notary/certificate/..." }` |
| 429 | Rate limited | `{ "error": "rate_limited", "retry_after": 60 }` |
| 503 | Operator wallet insufficient funds or node unavailable | `{ "error": "service_unavailable", "retry_after": 300 }` |

### 4.2 Verify

```
GET /api/v1/notary/verify/:document_hash
```

**Path parameters:**

| Parameter | Description |
|-----------|-------------|
| `document_hash` | Hex-encoded document hash to search for |

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `algorithm` | string | any | Filter by hash algorithm |

**Response (200):**

```json
{
  "verified": true,
  "matches": [
    {
      "policy_id": "a1b2c3d4...",
      "token_name": "e5f6a7b8...",
      "tx_hash": "48ae388c...",
      "slot": 106612345,
      "timestamp": "2026-03-12T14:30:00Z",
      "hash_algorithm": "SHA-256",
      "uri": "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      "notarizer": "0027a6fe95ff...",
      "description": "Annual audit report 2026",
      "status": "active",
      "certificate_url": "/notary/certificate/a1b2c3d4.../e5f6a7b8...",
      "explorer_url": "https://cardanoscan.io/transaction/48ae388c..."
    }
  ]
}
```

**When not found (200, not 404):**

```json
{
  "verified": false,
  "matches": []
}
```

Returns 200 even when not found — the query succeeded, it just found no matches.

### 4.3 Certificate

```
GET /api/v1/notary/certificate/:policyId/:tokenName
```

**Response (200):**

```json
{
  "policy_id": "a1b2c3d4...",
  "token_name": "e5f6a7b8...",
  "document_hash": "e3b0c44298fc...",
  "hash_algorithm": "SHA-256",
  "uri": "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  "notarizer": "0027a6fe95ff...",
  "description": "Annual audit report 2026",
  "tx_hash": "48ae388c...",
  "slot": 106612345,
  "timestamp": "2026-03-12T14:30:00Z",
  "block": 1234567,
  "status": "active",
  "nft_address": "addr1qx...",
  "explorer_url": "https://cardanoscan.io/transaction/48ae388c..."
}
```

| Status | Condition |
|--------|-----------|
| 200 | Found (active or revoked) |
| 404 | NFT never existed (unknown policy/token combination) |

**Revoked notarizations:** Return 200 with `"status": "revoked"` and include the `burn_tx_hash`. Do NOT return 404 for burned NFTs — the certificate must remain viewable to show revocation status.

### 4.4 Recent Notarizations

```
GET /api/v1/notary/recent?limit=10
```

Returns the most recent notarizations (public, no auth). For the landing page feed.

**Query parameters:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `limit` | integer | 10 | 50 | Number of results. Returns 400 if > 50. |

**Response (200):**

```json
{
  "notarizations": [
    {
      "tx_hash": "48ae388c...",
      "document_hash": "e3b0c442...",
      "hash_algorithm": "SHA-256",
      "description": "Annual audit report 2026",
      "timestamp": "2026-03-12T14:30:00Z",
      "certificate_url": "/notary/certificate/a1b2c3d4.../e5f6a7b8..."
    }
  ],
  "total": 42
}
```

### 4.5 Statistics

```
GET /api/v1/notary/stats
```

**Response (200):**

```json
{
  "total_notarizations": 42,
  "active": 40,
  "revoked": 2,
  "first_notarization": "2026-03-15T10:00:00Z",
  "latest_notarization": "2026-03-12T14:30:00Z"
}
```

### 4.6 Revoke (Admin Only)

```
DELETE /api/v1/notary/:policyId/:tokenName
Authorization: Bearer adv_admin_...
```

**Authentication:** Requires API key with `notary:burn` permission (admin keys only). Uses the same credits middleware as notarize — credits are reserved, deducted on success, released on failure.

**Response (202):**

```json
{
  "tx_hash": "7dcc5168...",
  "status": "revocation_submitted"
}
```

| Status | Condition |
|--------|-----------|
| 202 | Burn transaction submitted |
| 401 | Missing or invalid API key |
| 402 | Insufficient credits |
| 403 | Key lacks `notary:burn` permission |
| 404 | NFT not found |

---

## 5. Frontend Specification

### 5.1 Pages

All under `/notary` path on adavault.com (brand/domain decision deferred).

#### `/notary` — Landing + Submit

**Components:**
- Hero section: what the service does, key differentiators
- Hash submission form:
  - Drag-and-drop zone (file → client-side SHA-256 → show hash)
  - Manual hash input field (paste pre-computed hash)
  - Algorithm selector: SHA-256 (default) | BLAKE2b-256
  - Optional fields: URI, description, destination address
  - "Notarize" button
- Result panel (after submission):
  - Transaction hash with explorer link
  - Certificate link (shareable)
  - "Pending confirmation" → "Confirmed" (poll or SSE)
- Recent notarizations feed (from `/notary/recent`)
- Pricing section (flat fee — amount TBD)
- "How it works" section (3-step visual)

**Client-side hashing:**
```typescript
// SHA-256 via Web Crypto API (no dependencies)
async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
```

#### `/notary/verify` — Verification

**Components:**
- Hash input (drag-and-drop or paste)
- Algorithm filter (optional)
- Result display:
  - Green checkmark + details if verified
  - "Not found" message if no match
  - Multiple matches listed if >1

#### `/notary/certificate/:policyId/:tokenName` — Certificate

**Components:**
- Formatted certificate card (designed for screenshots/sharing)
- All datum fields displayed
- QR code linking to the certificate URL
- "Verify independently" link (CardanoScan)
- Burn/revocation status banner
- Open Graph meta tags for social sharing previews

#### `/notary/history` — User History (Phase 1.5)

**Deferred** — requires either wallet connection (Phase 2) or API key tracking. Park for now, include the route reservation.

#### `/notary/about` — Information

**Components:**
- Detailed explanation of how notarization works
- Comparison table (vs Bitcoin OP_RETURN, vs Cardano metadata, vs traditional notary)
- FAQ
- API documentation link (Swagger)
- Open-source contract link (GitHub)

### 5.2 UI Components (React)

| Component | Description | Island? |
|-----------|-------------|---------|
| `NotarySubmitForm` | Hash input + file drop + optional fields | Yes |
| `NotaryResult` | Post-submission result panel | Yes |
| `NotaryVerifyForm` | Verification input + results | Yes |
| `NotaryCertificate` | Certificate display card | Yes |
| `NotaryRecentFeed` | Recent notarizations list | Yes |
| `NotaryStats` | Service statistics display | Yes |
| `FileHasher` | Drag-and-drop + Web Crypto hashing | Yes |

### 5.3 Design

Follows existing ADAvault design language:
- Dark theme, ADAvault brand colours
- Same typography and spacing as pool pages
- Mobile-responsive (all pages)
- No new CSS framework or dependencies

---

## 6. Infrastructure

### 6.1 Reference Script Deployment

Deploy the notary validator as a CIP-33 reference script on-chain. This saves ~3-4 KB per transaction (script doesn't need to be included inline).

**Deployment:**
1. Build parameterized script with production notarizer VK hash and fee
2. Send to a UTxO with the script attached as reference
3. Lock with sufficient ADA (min UTxO + script size deposit, ~15-25 ADA)
4. Record the reference UTxO's tx hash + output index in API config

**Transaction building then uses:**
```typescript
.mintTxInReference(refScriptTxHash, refScriptOutputIndex)
// instead of:
.mintingScript(scriptCbor)
```

### 6.2 Operator Wallet

**Preview/preprod:** Existing preview wallet (`0027a6fe...`)
**Mainnet:** Dedicated notary operator wallet (new key pair, separate from pool keys)

The notarizer wallet needs:
- Sufficient ADA for transactions (~50 ADA reserve, keep balance low for security)
- BetterStack monitoring alert if balance drops below 20 ADA (same pattern as existing API health checks)
- Balance included in `/health` endpoint response (e.g. `"notary_wallet_ada": 47.5`)
- Key stored securely (encrypted at rest, same pattern as KES rotation)

### 6.3 Kupo Patterns

Add the notary policy ID as a Kupo pattern for UTxO tracking:

```bash
--match "<notary_policy_id>/*"
```

This enables the API to query all NFTs minted under the notary policy for verification lookups.

### 6.4 API Server

Notary endpoints added to the existing `adavault-api` Express server. No new service.

**New dependencies:**
- `@meshsdk/core`, `@meshsdk/provider`, `@meshsdk/wallet` — already in the E2E test harness, need adding to adavault-api
- `blakejs` — BLAKE2b hashing (already used in cardano-notary tests)
- `better-sqlite3` — credits engine storage (SQLite with WAL mode)

**Credits engine:** Initialised at API startup. SQLite database at `data/credits.db`.
See [CREDITS-ENGINE-SPEC.md](CREDITS-ENGINE-SPEC.md) for full design.

**Wallet initialisation:** AppWallet loaded at API startup with the operator signing key. Key path from environment variable, never committed.

### 6.5 Network Progression

| Phase | Network | Purpose |
|-------|---------|---------|
| Dev | Preview | Feature development, integration testing |
| QA | Preprod | Regression testing, performance validation |
| Production | Mainnet | Live service |

---

## 7. State & Storage

### 7.1 On-Chain (Source of Truth)

All notarization data lives on-chain as NFT datums. The API is a read layer over Kupo, not a database.

- **Notarize:** Mint NFT with datum → Kupo indexes the UTxO
- **Verify:** Query Kupo by policy ID → filter datums for matching hash
- **Certificate:** Query Kupo for specific NFT by policy + token name
- **Recent:** Query Kupo for all UTxOs under the policy, sort by slot
- **Stats:** Count UTxOs under the policy, count burned (query tx history)

### 7.2 Revocation Tracking

Burned NFTs disappear from Kupo (they are no longer UTxOs). To support revoked certificate display and stats, the API maintains a revocation index:

```typescript
interface RevocationEntry {
  policyId: string;
  tokenName: string;
  originalDatum: NotaryCacheEntry;  // preserved from before burn
  burnTxHash: string;
  burnSlot: number;
  revokedAt: string;
}
```

**Detection:** During each cache refresh, if a previously-known token is absent from Kupo, mark it as revoked. Persist the revocation index in SQLite (alongside credits.db or in a separate `notary.db`), so it survives restarts.

**Certificate endpoint:** For revoked tokens, return 200 with `"status": "revoked"`, the original datum fields, and the `burn_tx_hash`.

**Stats:** `revoked` count = size of the revocation index. `active` = current Kupo UTxO count.

### 7.3 Local Cache (Performance)

The API maintains an in-memory cache (same pattern as existing pool data caching):

```typescript
interface NotaryCache {
  notarizations: Map<string, NotaryCacheEntry>;  // keyed by policyId+tokenName
  byHash: Map<string, string[]>;                 // document_hash → [policyId+tokenName]
  lastRefresh: number;
  total: number;
  active: number;
}
```

- Refreshed every 60 seconds (same cadence as pool stats)
- Cold start: full scan of Kupo UTxOs under the policy
- Incremental: only fetch UTxOs created since last checkpoint
- **Write-through on notarize:** After a successful mint, insert the new entry into the cache immediately (before the next Kupo refresh). Entry shows as "pending" until Kupo confirms.

### 7.4 Auto-Refund on On-Chain Failure

When the API returns 202, credits are deducted immediately. If the transaction fails to confirm on-chain, credits must be refunded automatically.

**Mechanism:** A background job runs every 60 seconds (piggybacked on the cache refresh cycle):
1. Check all recent notarizations with status "submitted" older than 5 minutes
2. Query Kupo for the expected NFT UTxO
3. If not found after 5 minutes → mark as "failed", issue automatic refund via `engine.refund()`
4. Log with ledger type `auto_refund` and reference = original tx hash

**Credits flow for a failed tx:**
- On submit: `reserve(2000)` → `deduct(2000)` (202 returned)
- After 5 min timeout: `refund(2000)` (auto_refund ledger entry)

### 7.5 UTxO Selection and Locking

Concurrent notarization requests must not select the same UTxO for the one-shot token name derivation.

**Mechanism:** In-memory set of "in-flight" UTxO references (locked during tx building + submission):

```typescript
const inFlightUtxos = new Set<string>();  // "txHash#outputIndex"

function selectAndLockUtxo(utxos: UTxO[]): UTxO | null {
  // Select first unlocked pure-ADA UTxO
  for (const u of utxos) {
    const key = `${u.input.txHash}#${u.input.outputIndex}`;
    if (!inFlightUtxos.has(key)) {
      inFlightUtxos.add(key);
      return u;
    }
  }
  return null;  // All UTxOs locked — 503, retry later
}

function releaseUtxo(utxo: UTxO): void {
  inFlightUtxos.delete(`${utxo.input.txHash}#${utxo.input.outputIndex}`);
}
```

UTxOs are released on tx confirmation, tx failure, or after a 2-minute safety timeout.

### 7.6 Duplicate Detection

Before building a notarization transaction, the API checks its cache for an existing notarization with the same `document_hash` by the same notarizer. Returns 409 if found.

**Important:** Duplicate detection is best-effort (cache-based, up to 60s lag after mint). The on-chain contract does NOT enforce hash uniqueness — the API is the only guard. Clients may bypass the check by setting `"allow_duplicate": true` in the request.

---

## 8. Error Handling

### 8.1 Transaction Failures

| Failure | Cause | API Response | Recovery |
|---------|-------|-------------|----------|
| Insufficient funds | Operator wallet drained | 503 + alert | Top up wallet |
| UTxO contention | Concurrent notarizations consume same UTxO | Retry (automatic, 1x after 2s, re-selects UTxO). Credit reservation held during retry. | Retry with different UTxO |
| Script validation failure | Bug or invalid params | 500 + log | Investigate |
| Node unreachable | Ogmios/Kupo down | 503 | Failover to DR |
| Tx not confirmed | Submitted but not included in block | Poll, timeout after 5 min | Re-submit or alert |

### 8.2 Input Validation

| Field | Validation | Error |
|-------|-----------|-------|
| `document_hash` | Hex string, exactly 64 chars. Normalised to lowercase on receipt. Both SHA-256 and BLAKE2b-256 produce 32-byte (64 hex char) digests. | 400: "Invalid hash format" |
| `hash_algorithm` | One of: `SHA-256`, `BLAKE2b-256` | 400: "Unsupported algorithm" |
| `uri` | Scheme must be one of: `https`, `http`, `ipfs`, `ar` (Arweave). Max 256 bytes UTF-8. All other schemes rejected. | 400: "Invalid URI" |
| `description` | Max 256 bytes UTF-8 | 400: "Description too long" |
| `destination` | Valid Bech32 Cardano address (mainnet or testnet as appropriate), validated via MeshJS address parsing | 400: "Invalid destination address" |

### 8.3 Rate Limiting

Two layers, both enforced. The effective limit is the minimum of both:

**Layer 1 — nginx IP-based (DDoS backstop):** Applies to ALL requests regardless of auth status.
- Metered endpoints (notarize, revoke): 10 req/min per IP
- Read endpoints (verify, certificate, recent, stats): 60 req/min per IP

**Layer 2 — Per API key (application-level):** Applies to authenticated endpoints only. Configurable per key via `api_keys.rate_limit` (default: 60 req/min).

A single client with one API key behind one IP is limited by whichever threshold is lower.

---

## 9. Security

### 9.1 Notarizer Signing Key Protection

The notarizer signing key (Cardano payment key) is loaded at API startup and held in process memory for the lifetime of the Express process.

- Signing key path from environment variable (`NOTARY_SKEY_PATH`), never in code or config files
- Key file permissions: `0400` (read-only, owner only)
- Separate key for each network (preview, preprod, mainnet)
- Mainnet key encrypted at rest (GPG, same pattern as KES cold keys)

**Threat model:** If the Express process is compromised (RCE via dependency vulnerability), the signing key is in-process memory and could be exfiltrated. Mitigations:
- Keep operator wallet balance low (~50 ADA reserve). Top up as needed.
- `fee_lovelace` parameter acts as a drain-rate limiter (attacker must pay fee per mint)
- BetterStack wallet balance monitor alerts on unexpected drops
- Phase 2+: consider an external signing service with per-minute rate caps

### 9.2 API Authentication

Authentication via **credits engine API keys** (see [CREDITS-ENGINE-SPEC.md](CREDITS-ENGINE-SPEC.md)):

- **Notarize:** API key required, credits deducted (reserve → deduct on success, release on failure)
- **Burn:** API key required (operator/admin key only), credits deducted
- **Verify/Certificate/Recent/Stats:** No auth required (free, public read endpoints)
- **Credits management** (balance, usage, ledger): API key required, no credit cost

Rate limiting enforced per API key (configurable per key, default 60 req/min)
plus nginx IP-based rate limits as backstop for unauthenticated endpoints.

### 9.3 Input Sanitisation

- Document hash: hex-only regex (`/^[0-9a-f]{64}$/i`), normalised to lowercase before storage and comparison
- URI: scheme whitelist (`https`, `http`, `ipfs`, `ar`) — all other schemes (including `javascript:`, `data:`) rejected. Stored as raw bytes on-chain. Displayed as plain text with a "visit link" button using `rel="noopener noreferrer" target="_blank"`. Never rendered as bare `<a href>` without scheme validation.
- Description: sanitised, HTML-escaped on display, stored as raw bytes on-chain
- Destination address: validated via MeshJS address parsing before use in transaction

**Note on verification data:** All notarization data is public on-chain — the same information is available by querying the blockchain directly via Kupo or a block explorer. The API is a convenience layer, not an access control layer. The verify endpoint intentionally returns all matching data without authentication.

### 9.4 Front-End Security

- File never uploaded — hashing is client-side only via Web Crypto API
- No document content ever reaches the server
- CSP headers prevent XSS (existing CSP policy applies)
- Certificate pages: all datum values HTML-escaped before rendering

### 9.5 On-Chain Security

Already validated by the 13 Aiken tests (11 unit + 2 property-based):
- Notarizer signature required for mint and burn
- One-shot UTxO consumption prevents replay
- Exactly-one-token check prevents batch minting exploits
- Fee enforcement prevents free-loading
- Datum type check prevents malformed data

---

## 10. Testing Plan

### 10.1 Contract Tests (Existing)

13 Aiken tests (11 unit + 2 property-based) in `vault/validators/notary.ak`:
- Happy path: notarize, with URI, with description, overpay fee
- Failure path: no signature, underpay, no fee, wrong UTxO, double mint
- Burn: success, no signature failure
- Property: random stranger can't notarize, any fee >= min works

### 10.2 E2E Tests (Existing)

In `cardano-notary/test/integration.ts`:
- Notarize on preview → verify → burn lifecycle
- Already passing on preview testnet

### 10.3 Credits Engine Tests (New — Phase 1)

| Test | Description |
|------|-------------|
| Key creation | CLI creates key, returns full key once |
| Key validation | Valid key → pass, invalid → 401 |
| Key status | Suspended/revoked keys rejected with 403 |
| Credit top-up | Manual top-up increases balance |
| Reserve → deduct | Successful request deducts credits |
| Reserve → release | Failed request releases reserved credits |
| Insufficient credits | 402 with balance details |
| Concurrent reserves | No double-spend under concurrent requests |
| Ledger integrity | All operations produce ledger entries |
| Rate limiting | Per-key rate limit enforced |
| Free operations | Zero-cost endpoints don't deduct |

### 10.4 API Tests (New — Phase 1)

| Test | Description |
|------|-------------|
| `POST /notarize` — happy path | Submit valid hash with API key, get 202 + tx hash |
| `POST /notarize` — no API key | Missing key, get 401 |
| `POST /notarize` — insufficient credits | 402 with balance |
| `POST /notarize` — invalid hash | Bad format, get 400 |
| `POST /notarize` — duplicate | Same hash twice, get 409 |
| `POST /notarize` — with destination | NFT goes to specified address |
| `POST /notarize` — with URI + desc | Optional fields stored correctly |
| `POST /notarize` — credits deducted | Balance reduced after success |
| `POST /notarize` — credits released on failure | Balance restored on tx failure |
| `GET /verify/:hash` — found | Verify existing notarization (no key needed) |
| `GET /verify/:hash` — not found | 200 with empty matches |
| `GET /certificate/:p/:t` — found | Full certificate data |
| `GET /certificate/:p/:t` — 404 | Non-existent NFT |
| `GET /recent` | Returns recent notarizations |
| `GET /stats` | Returns aggregate statistics |
| `DELETE /:p/:t` — no auth | 401 |
| `DELETE /:p/:t` — with admin key | 202 + burn tx hash |
| `GET /credits/balance` | Returns current balance |
| `GET /credits/usage` | Returns usage breakdown |
| `GET /credits/ledger` | Returns ledger entries |
| Rate limiting | 429 after threshold |

### 10.5 Frontend Tests (New — Phase 1)

Playwright E2E tests (extend existing harness):

| Test | Description |
|------|-------------|
| Notary page loads | `/notary` renders without errors |
| File hash computation | Drop file → correct SHA-256 displayed |
| Manual hash input | Paste hash → accepted |
| Verify page loads | `/notary/verify` renders |
| Certificate page loads | `/notary/certificate/:p/:t` renders |
| Mobile responsive | All pages render correctly on mobile viewport |

### 10.6 Network Progression

1. **Preview:** All development and initial integration
2. **Preprod:** Full regression before mainnet (different operator key)
3. **Mainnet:** Final deployment with production key

---

## 11. Open Items

| # | Item | Status | Owner |
|---|------|--------|-------|
| 1 | Flat fee amount (in credits) | TBD — separate pricing discussion | CxO |
| 2 | Brand/domain | TBD — `/notary` path vs separate domain — deep dive scheduled | CxO |
| 3 | ~~Payment collection~~ | **Resolved:** Credits engine with pluggable providers. Manual (Phase 1) → Stripe → ADA on-chain → x402 | — |
| 4 | Notary history page | Deferred to Phase 1.5 — now feasible via API key (credits engine tracks usage) | Dev team |
| 5 | Monitoring/alerting | BetterStack monitor for notary-specific health endpoint | Dev team |
| 6 | Mainnet operator key | Generate, encrypt, secure storage plan | Dev team + CxO |
| 7 | Credits engine open items | 9 items in [CREDITS-ENGINE-SPEC.md §13](CREDITS-ENGINE-SPEC.md#13-open-items) | Mixed |

---

## Appendix A: Slot-to-Timestamp Conversion

Cardano slots map to POSIX time via network-specific genesis parameters.
All networks use 1-second slots post-Shelley.

```typescript
const NETWORK_GENESIS: Record<string, { systemStart: number; shelleyOffset: number }> = {
  preview:  { systemStart: 1666656000, shelleyOffset: 0 },       // 2022-10-25T00:00:00Z
  preprod:  { systemStart: 1654041600, shelleyOffset: 86400 },    // 2022-06-01T00:00:00Z + 1 day
  mainnet:  { systemStart: 1596059091, shelleyOffset: 4924800 },  // 2020-07-29T21:44:51Z + 57 days
};

function slotToTimestamp(slot: number, network: string): Date {
  const genesis = NETWORK_GENESIS[network];
  return new Date((genesis.systemStart + slot) * 1000);
}
```

The transaction's slot (from Kupo) gives the on-chain timestamp. Alternatively, use MeshJS or Ogmios utilities which handle the conversion internally.

## Appendix B: Token Name Example

For a UTxO `48ae388c...#0`:
```
CBOR = d879 9f 5820 48ae388c...{32 bytes} 00 ff
Token name = blake2b_256(CBOR) = <32 bytes hex>
```

This is deterministic — anyone can independently derive the token name from the UTxO reference.
