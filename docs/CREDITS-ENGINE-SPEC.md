# Credits Engine — Component Specification

Reusable API billing component for ADAvault services. Manages API keys,
credit balances, usage metering, and pluggable payment providers.

**Date:** 2026-03-12
**Status:** Draft — awaiting CxO approval
**Consumers:** Notary service (Phase 1), vault service (R2.1), future API products
**Reuse target:** Any Cardano SPO running ADAvault-derived services

---

## Table of Contents

1. [Design Goals](#1-design-goals)
2. [Architecture](#2-architecture)
3. [Data Model](#3-data-model)
4. [API Key Design](#4-api-key-design)
5. [Credits Lifecycle](#5-credits-lifecycle)
6. [Provider Interface](#6-provider-interface)
7. [API Specification](#7-api-specification)
8. [Middleware Integration](#8-middleware-integration)
9. [Storage](#9-storage)
10. [Security](#10-security)
11. [Operational](#11-operational)
12. [Phased Delivery](#12-phased-delivery)
13. [Open Items](#13-open-items)

---

## 1. Design Goals

1. **Reusable** — not coupled to notary. Any service deducts credits via middleware.
2. **Simple** — API key = identity = credit balance. No user accounts, no OAuth, no sessions.
3. **Auditable** — every credit movement (top-up, deduction, refund) is an immutable ledger entry.
4. **Provider-agnostic** — payment providers are plugins. Start manual, add Stripe, add ADA on-chain, add x402.
5. **SPO-portable** — another SPO can deploy with their own config, keys, and payment credentials.
6. **Operationally light** — SQLite for storage, no external database dependency.

---

## 2. Architecture

```
                         ┌──────────────────────────────┐
  Client request         │       adavault-api           │
  with API key           │                              │
  ──────────────────────>│  ┌────────────────────────┐  │
                         │  │  Credits Middleware     │  │
                         │  │                        │  │
                         │  │  1. Validate API key   │  │
                         │  │  2. Check balance      │  │
                         │  │  3. Reserve credits    │  │
                         │  │  4. Call next()        │  │
                         │  │  5. Deduct on success  │  │
                         │  │     or release on fail │  │
                         │  └───────────┬────────────┘  │
                         │              │               │
                         │  ┌───────────▼────────────┐  │
                         │  │  Credits Engine         │  │
                         │  │  (lib/credits/)         │  │
                         │  │                         │  │
                         │  │  - Key management       │  │
                         │  │  - Balance operations    │  │
                         │  │  - Ledger (append-only)  │  │
                         │  │  - Provider registry     │  │
                         │  └───────────┬─────────────┘ │
                         │              │               │
                         │  ┌───────────▼─────────────┐ │
                         │  │  Payment Providers       │ │
                         │  │  (lib/credits/providers/)│ │
                         │  │                          │ │
                         │  │  ┌────────┐ ┌─────────┐ │ │
                         │  │  │ Manual │ │  Stripe │ │ │
                         │  │  └────────┘ └─────────┘ │ │
                         │  │  ┌────────┐ ┌─────────┐ │ │
                         │  │  │  ADA   │ │  x402   │ │ │
                         │  │  └────────┘ └─────────┘ │ │
                         │  └─────────────────────────┘ │
                         │              │               │
                         │  ┌───────────▼─────────────┐ │
                         │  │  SQLite                  │ │
                         │  │  credits.db              │ │
                         │  └──────────────────────────┘ │
                         └──────────────────────────────┘
```

### Module Location

```
adavault-api/
└── src/
    └── lib/
        └── credits/
            ├── index.ts            # Public API — init(), middleware()
            ├── engine.ts           # Core logic — keys, balances, ledger
            ├── store.ts            # SQLite persistence
            ├── middleware.ts       # Express middleware
            ├── types.ts            # Shared types and interfaces
            └── providers/
                ├── index.ts        # Provider registry
                ├── manual.ts       # Admin-issued credits (Phase 1)
                ├── stripe.ts       # Stripe Checkout (Phase 2)
                ├── ada-onchain.ts  # ADA deposit monitoring (Phase 3)
                └── x402.ts         # x402 protocol (Phase 4)
```

Starts as a directory within adavault-api. Designed for extraction to its own
npm package when a second service needs it — no imports from outside `lib/credits/`.

---

## 3. Data Model

### 3.1 API Keys

```sql
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,                 -- UUID v4 (not the API key itself)
  key_hash      TEXT NOT NULL UNIQUE,             -- SHA-256 of the full key (never store plaintext)
  key_prefix    TEXT NOT NULL,                    -- first 8 chars for identification (adv_live_Ab3x)
  name          TEXT NOT NULL,                    -- human label ("Russ's notary key")
  environment   TEXT NOT NULL CHECK (environment IN ('live', 'test')),
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended', 'revoked')),
  permissions   TEXT NOT NULL DEFAULT '["*"]',    -- JSON array of service scopes
  rate_limit    INTEGER NOT NULL DEFAULT 60,      -- requests per minute
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT,
  revoked_at    TEXT,
  metadata      TEXT DEFAULT '{}'                 -- JSON, extensible (contact email, notes)
);
```

### 3.2 Credit Balances

```sql
CREATE TABLE balances (
  key_id        TEXT PRIMARY KEY REFERENCES api_keys(id),
  available     INTEGER NOT NULL DEFAULT 0       -- usable credits (millicredits)
                CHECK (available >= 0),
  reserved      INTEGER NOT NULL DEFAULT 0       -- held during in-flight requests
                CHECK (reserved >= 0),
  lifetime_used INTEGER NOT NULL DEFAULT 0,       -- total credits ever consumed
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Units:** 1 credit = 1000 millicredits. Allows sub-credit pricing without floating point.
A notarization might cost 2000 millicredits (2 credits). A verification might cost 0.

### 3.3 Ledger (Append-Only)

```sql
CREATE TABLE ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id        TEXT NOT NULL REFERENCES api_keys(id),
  type          TEXT NOT NULL CHECK (type IN (
                  'topup', 'deduction', 'refund', 'reserve', 'release',
                  'adjust', 'expiry'
                )),
  amount        INTEGER NOT NULL,                 -- millicredits (positive = credit, negative = debit)
  balance_after INTEGER NOT NULL,                 -- balance snapshot after this entry
  service       TEXT,                             -- which service ('notary', 'vault', etc.)
  reference     TEXT,                             -- tx hash, Stripe payment ID, admin note, etc.
  provider      TEXT,                             -- 'manual', 'stripe', 'ada_onchain', 'x402'
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  metadata      TEXT DEFAULT '{}'                 -- JSON, extensible
);

CREATE INDEX idx_ledger_key_id ON ledger(key_id);
CREATE INDEX idx_ledger_created ON ledger(created_at);
CREATE INDEX idx_ledger_type ON ledger(type);
```

### 3.4 Service Pricing

```sql
CREATE TABLE pricing (
  service       TEXT NOT NULL,                    -- 'notary', 'vault', etc.
  operation     TEXT NOT NULL,                    -- 'notarize', 'verify', 'burn', etc.
  cost          INTEGER NOT NULL,                 -- millicredits per operation
  environment   TEXT NOT NULL CHECK (environment IN ('live', 'test')),
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (service, operation, environment)
);
```

Example pricing:

| Service | Operation | Cost (credits) | Cost (millicredits) |
|---------|-----------|---------------|---------------------|
| notary | notarize | 2 | 2000 |
| notary | verify | 0 | 0 |
| notary | burn | 1 | 1000 |
| notary | certificate | 0 | 0 |

Free operations (verify, certificate) still go through the middleware for
rate limiting and usage tracking — they just cost 0.

**Pricing updates:** The `pricing` table uses a composite primary key
`(service, operation, environment)`. Changing a price is an `UPDATE`, not an
`INSERT` — this overwrites the previous price with no history. To preserve
price history for auditing, add a new row with a different `effective_from`
and query with `WHERE effective_from <= datetime('now') ORDER BY effective_from
DESC LIMIT 1`. Phase 1 uses the simpler UPDATE approach.

---

## 4. API Key Design

### 4.1 Format

```
adv_live_Ab3xK9mN2pQr5tWv8yBcDfGh
adv_test_Jk4mP7nR1sUw3xYz6aCeHgLi
└──┘└──┘ └──────────────────────────┘
 │    │              │
 │    │   24 chars: crypto random (base62)
 │    │
 │    └── environment: live | test
 │
 └── prefix: "adv" (adavault)
```

- **Total length:** 33 characters (prefix + separator + env + separator + 24 random)
- **Entropy:** 24 base62 chars = ~143 bits (more than sufficient)
- **Prefix purpose:** instantly identifies ADAvault keys in logs, env vars, config
- **Test keys:** hit the same API but against test-mode pricing (0 cost), useful for integration development

### 4.2 Key Display

The full key is shown **exactly once** — at creation time. After that, only the
prefix is visible:

```
Created: adv_live_Ab3xK9mN2pQr5tWv8yBcDfGh   ← shown once, user must save
Display: adv_live_Ab3x****                     ← all subsequent views
```

### 4.3 Storage

Keys are **hashed** (SHA-256) before storage. Lookup flow:

1. Client sends `Authorization: Bearer adv_live_Ab3xK9mN2pQr5tWv8yBcDfGh`
2. Middleware hashes the key: `SHA-256("adv_live_Ab3xK9mN2pQr5tWv8yBcDfGh")`
3. Looks up the hash in `api_keys.key_hash`
4. If found and status = active → proceed

### 4.4 Permissions (Scoping)

```json
["*"]                        // all services
["notary"]                   // notary only
["notary", "vault"]          // notary + vault
["notary:notarize"]          // notary notarize only (no burn)
```

Phase 1: all keys get `["*"]`. Fine-grained scoping is the mechanism, but
we don't need a UI for it yet.

**Validation:** Permissions JSON MUST be validated on write (key creation and
update). The `permissions` field must be a JSON array of non-empty strings
matching `^[a-z_]+(:[a-z_]+)?$` or exactly `"*"`. On read, if parsing fails
(corrupt data), the key MUST be treated as having no permissions (fail closed).

### 4.5 Lifecycle

| Phase | Key Creation | Key Management |
|-------|-------------|----------------|
| Phase 1 | Operator CLI tool (`npm run credits:create-key`) | Operator CLI |
| Phase 2 | Self-service via API (with email verification) | Web UI |
| Phase 3 | Self-service with wallet-linked identity | Web UI + wallet |

Phase 1 is intentionally manual — we control who gets keys during launch.

---

## 5. Credits Lifecycle

### 5.1 Request Flow (Reserve → Deduct Pattern)

```
Client                    Middleware                Engine                  Service
  │                          │                        │                       │
  │  Request + API key       │                        │                       │
  │─────────────────────────>│                        │                       │
  │                          │  1. validateKey()      │                       │
  │                          │───────────────────────>│                       │
  │                          │  2. key valid ✓        │                       │
  │                          │<──────────────────────│                       │
  │                          │                        │                       │
  │                          │  3. reserve(key, cost) │                       │
  │                          │───────────────────────>│                       │
  │                          │     available -= cost  │                       │
  │                          │     reserved += cost   │                       │
  │                          │  4. reserved ✓         │                       │
  │                          │<──────────────────────│                       │
  │                          │                        │                       │
  │                          │  5. next() ───────────────────────────────────>│
  │                          │                        │                       │
  │                          │                        │    6. Do work         │
  │                          │                        │    (mint NFT, etc.)   │
  │                          │                        │                       │
  │                          │  7a. ON SUCCESS:       │                       │
  │                          │     deduct(key, cost)  │                       │
  │                          │───────────────────────>│                       │
  │                          │     reserved -= cost   │                       │
  │                          │     lifetime_used += cost                      │
  │                          │     ledger: 'deduction' │                      │
  │                          │                        │                       │
  │                          │  7b. ON FAILURE:       │                       │
  │                          │     release(key, cost) │                       │
  │                          │───────────────────────>│                       │
  │                          │     reserved -= cost   │                       │
  │                          │     available += cost  │                       │
  │                          │     ledger: 'release'  │                       │
  │                          │                        │                       │
  │  Response                │                        │                       │
  │<─────────────────────────│                        │                       │
```

**Why reserve-then-deduct?** If the notarization transaction fails (node down,
UTxO contention), the user shouldn't lose credits. Reservation holds them during
processing; release returns them on failure.

### 5.2 Top-Up Flow

```
                     ┌───────────────┐
                     │ Payment       │
                     │ Provider      │
                     │ (any)         │
                     └──────┬────────┘
                            │ payment confirmed
                            ▼
                     ┌───────────────┐
                     │ Engine        │
                     │               │
                     │ topup(        │
                     │   key_id,     │
                     │   amount,     │
                     │   provider,   │
                     │   reference   │
                     │ )             │
                     │               │
                     │ available +=  │
                     │ ledger entry  │
                     └───────────────┘
```

All providers ultimately call the same `topup()` function. The provider is
responsible for confirming payment before calling it.

### 5.3 Credit Operations

| Operation | Effect | Ledger Type | When |
|-----------|--------|-------------|------|
| `topup` | available += amount | `topup` | Payment confirmed |
| `reserve` | available -= amount, reserved += amount | `reserve` | Request starts |
| `deduct` | reserved -= amount, lifetime_used += amount | `deduction` | Request succeeds |
| `release` | reserved -= amount, available += amount | `release` | Request fails |
| `refund` | available += amount | `refund` | Operator-initiated |
| `adjust` | available += amount (can be negative) | `adjust` | Operator correction |

---

## 6. Provider Interface

### 6.1 Interface Definition

```typescript
interface PaymentProvider {
  /** Unique identifier for this provider */
  readonly name: string;

  /** Initialise the provider (called once at startup) */
  init(config: ProviderConfig): Promise<void>;

  /**
   * Handle a top-up request. Provider-specific flow:
   * - Manual: admin CLI credits immediately
   * - Stripe: returns checkout URL, webhook confirms
   * - ADA: returns deposit address, chain monitor confirms
   * - x402: inline with request (402 → pay → retry)
   */
  createTopup(keyId: string, amount: number): Promise<TopupResult>;

  /**
   * Verify a payment (for async providers like Stripe webhooks
   * or ADA chain monitoring). Called by the provider's callback handler.
   */
  verifyPayment(reference: string): Promise<PaymentVerification>;

  /** Provider-specific webhook/callback handler (Express router) */
  getRouter?(): Router;

  /** Shutdown (cleanup connections, stop monitors) */
  shutdown?(): Promise<void>;
}

interface TopupResult {
  status: 'completed' | 'pending';
  reference: string;
  redirectUrl?: string;     // Stripe checkout URL
  depositAddress?: string;  // ADA deposit address
  expiresAt?: string;       // deadline for pending payments
}

interface PaymentVerification {
  valid: boolean;
  amount: number;           // millicredits
  reference: string;
}

interface ProviderConfig {
  [key: string]: unknown;   // provider-specific config from environment
}
```

### 6.2 Provider Implementations

#### Manual (Phase 1)

Operator issues credits via CLI. No external payment system.

```bash
# Create a key and give it 100 credits
npm run credits:create-key -- --name "Test user" --env live
# Output: adv_live_Ab3xK9mN2pQr5tWv8yBcDfGh (SAVE THIS — shown once)

# Top up credits
npm run credits:topup -- --key-prefix "adv_live_Ab3x" --amount 100 --note "Initial allocation"

# Check balance
npm run credits:balance -- --key-prefix "adv_live_Ab3x"
```

Implementation: calls `engine.topup()` directly. Reference = admin note.

**Key prefix collision:** CLI tools that accept `--key-prefix` MUST verify the
prefix matches exactly one key. If multiple keys share a prefix (e.g. two keys
starting with `adv_live_Ab3x`), the command MUST fail with an error listing the
matches and asking the operator to provide more characters.

#### Stripe (Phase 2)

User clicks "Buy Credits" → Stripe Checkout → webhook confirms → credits added.

```
User → GET /credits/topup?amount=50 → Stripe Checkout URL
         ↓
User completes payment on Stripe
         ↓
Stripe → POST /credits/webhooks/stripe (webhook)
         ↓
Engine → topup(key_id, amount, 'stripe', stripe_payment_id)
```

Config: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`

#### ADA On-Chain (Phase 3)

Each API key gets a unique deposit address. Chain monitor watches for payments.

```
User → GET /credits/deposit-address → unique Cardano address
         ↓
User sends ADA to that address
         ↓
Kupo detects UTxO at deposit address
         ↓
Monitor → topup(key_id, ada_to_credits(amount), 'ada_onchain', tx_hash)
```

Conversion rate configurable (e.g. 1 ADA = 10 credits).

#### x402 (Phase 4)

Payment inline with the API request. No pre-loading needed.

```
Client → GET /notary/notarize (no payment)
         ↓
Server → 402 Payment Required + payment instructions
         ↓
Client → pays via x402 protocol (ADA/USDC)
         ↓
Client → retries request with payment proof header
         ↓
Middleware → verifies payment → topup + immediate deduct
```

This is the cleanest UX — no API key management, no pre-loading. But requires
x402 Cardano support (not yet available).

---

## 7. API Specification

### 7.1 Key Management (Operator Only — Phase 1)

Phase 1 uses CLI tools, not API endpoints, for key management. API endpoints
added in Phase 2 for self-service.

**Phase 2 endpoints (design now, build later):**

```
POST   /api/v1/credits/keys              Create new API key
GET    /api/v1/credits/keys              List keys (operator: all, user: own)
DELETE /api/v1/credits/keys/:keyPrefix   Revoke a key
```

### 7.2 Balance & Usage

```
GET /api/v1/credits/balance
Authorization: Bearer adv_live_...
```

**Response (200):**

```json
{
  "available": 48000,
  "reserved": 2000,
  "lifetime_used": 150000,
  "unit": "millicredits",
  "available_credits": 48.0,
  "reserved_credits": 2.0
}
```

```
GET /api/v1/credits/usage?from=2026-03-01&to=2026-03-12&service=notary
Authorization: Bearer adv_live_...

# Maximum date range: 90 days. Requests exceeding this return 400.
```

**Response (200):**

```json
{
  "period": {
    "from": "2026-03-01T00:00:00Z",
    "to": "2026-03-12T23:59:59Z"
  },
  "total_used": 24000,
  "by_service": {
    "notary": {
      "notarize": { "count": 10, "total_cost": 20000 },
      "burn": { "count": 4, "total_cost": 4000 }
    }
  },
  "unit": "millicredits"
}
```

```
GET /api/v1/credits/ledger?limit=20&offset=0
Authorization: Bearer adv_live_...
```

**Response (200):**

```json
{
  "entries": [
    {
      "id": 42,
      "type": "deduction",
      "amount": -2000,
      "balance_after": 48000,
      "service": "notary",
      "reference": "48ae388c24e5...",
      "provider": null,
      "created_at": "2026-03-12T14:30:00Z"
    },
    {
      "id": 41,
      "type": "topup",
      "amount": 100000,
      "balance_after": 50000,
      "service": null,
      "reference": "Initial allocation",
      "provider": "manual",
      "created_at": "2026-03-12T10:00:00Z"
    }
  ],
  "total": 42,
  "unit": "millicredits"
}
```

### 7.3 Top-Up (Phase 2+)

```
POST /api/v1/credits/topup
Authorization: Bearer adv_live_...
Content-Type: application/json

{
  "amount": 50,
  "provider": "stripe"
}
```

**Response (200) — Stripe:**

```json
{
  "status": "pending",
  "redirect_url": "https://checkout.stripe.com/c/pay/cs_live_...",
  "expires_at": "2026-03-12T15:30:00Z"
}
```

**Response (200) — ADA on-chain:**

```json
{
  "status": "pending",
  "deposit_address": "addr1qx...",
  "amount_ada": "5.0",
  "expires_at": "2026-03-12T15:30:00Z"
}
```

---

## 8. Middleware Integration

### 8.1 Express Middleware

```typescript
import { creditsMiddleware } from './lib/credits';

// Free endpoints — no credits check, no API key required
app.get('/api/v1/notary/verify/:hash', notaryVerifyHandler);
app.get('/api/v1/notary/certificate/:policyId/:tokenName', notaryCertHandler);
app.get('/api/v1/notary/recent', notaryRecentHandler);
app.get('/api/v1/notary/stats', notaryStatsHandler);

// Metered endpoints — API key required, credits deducted
app.post('/api/v1/notary/notarize',
  creditsMiddleware({ service: 'notary', operation: 'notarize' }),
  notaryNotarizeHandler
);

app.delete('/api/v1/notary/:policyId/:tokenName',
  creditsMiddleware({ service: 'notary', operation: 'burn' }),
  notaryBurnHandler
);

// Credits management — API key required, no credit cost
app.get('/api/v1/credits/balance',
  creditsMiddleware({ service: 'credits', operation: 'balance' }),
  creditsBalanceHandler
);
```

### 8.2 Middleware Behaviour

```typescript
function creditsMiddleware(opts: { service: string; operation: string }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // 1. Extract API key from Authorization header
    const apiKey = extractBearerToken(req);
    if (!apiKey) return res.status(401).json({ error: 'Missing API key' });

    // 2. Validate key
    const key = await engine.validateKey(apiKey);
    if (!key) return res.status(401).json({ error: 'Invalid API key' });
    if (key.status !== 'active')
      return res.status(403).json({ error: 'Key suspended or revoked' });

    // 3. Check permissions
    if (!hasPermission(key, opts.service, opts.operation))
      return res.status(403).json({ error: 'Insufficient permissions' });

    // 4. Rate limit check
    if (await isRateLimited(key))
      return res.status(429).json({ error: 'Rate limited', retry_after: 60 });

    // 5. Look up cost
    const cost = await engine.getCost(opts.service, opts.operation, key.environment);

    // 6. Reserve credits (skip if free operation)
    if (cost > 0) {
      const reserved = await engine.reserve(key.id, cost);
      if (!reserved)
        return res.status(402).json({
          error: 'Insufficient credits',
          available: await engine.getBalance(key.id),
          required: cost,
        });
    }

    // 7. Attach context to request for downstream handlers
    req.credits = { keyId: key.id, cost, service: opts.service, operation: opts.operation };

    // 8. Hook into response completion via on-finished (handles normal, error, and aborted)
    const onFinished = require('on-finished');
    onFinished(res, () => {
      if (cost > 0) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          engine.deduct(key.id, cost, opts.service, req.credits.reference);
        } else {
          engine.release(key.id, cost);
        }
      }
      // Update last_used_at
      engine.touchKey(key.id);
    });

    next();
  };
}
```

### 8.3 Service Handler Sets Reference

The downstream handler sets the ledger reference (e.g. tx hash) on the request:

```typescript
async function notaryNotarizeHandler(req: Request, res: Response) {
  // ... build and submit transaction ...
  req.credits.reference = submittedTxHash;  // stored in ledger
  res.status(202).json({ tx_hash: submittedTxHash, ... });
}
```

### 8.4 Free Endpoints

Endpoints that don't go through `creditsMiddleware` are completely open —
no API key, no rate limiting beyond nginx. This is intentional for
verification (anyone should be able to verify without an account).

### 8.5 Orphan Reservation Cleanup

If a request crashes or the connection is aborted before `on-finished` fires
(e.g. server OOM, uncaught exception), credits may remain in `reserved`
indefinitely. A background cron job releases orphans:

```typescript
// Runs every 5 minutes
function cleanupOrphanReservations() {
  // Any reservation older than 10 minutes is considered orphaned.
  // Normal request lifecycle completes in <30 seconds.
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const orphans = db.prepare(`
    SELECT key_id, SUM(amount) as total
    FROM ledger
    WHERE type = 'reserve'
      AND created_at < ?
      AND id NOT IN (
        SELECT l2.id FROM ledger l2
        WHERE l2.type IN ('deduction', 'release')
          AND l2.reference = ledger.reference
      )
    GROUP BY key_id
  `).all(cutoff);

  for (const orphan of orphans) {
    engine.release(orphan.key_id, orphan.total);
    log.warn('Released orphan reservation', { keyId: orphan.key_id, amount: orphan.total });
  }
}
```

---

## 9. Storage

### 9.1 SQLite

Single file, path configured via `CREDITS_DB_PATH` environment variable.
Default: `data/credits.db` (relative to adavault-api working directory).

**Why SQLite:**
- No external database dependency (PostgreSQL, Redis etc.)
- ACID transactions for credit operations (no double-spend)
- WAL mode for concurrent reads during request processing
- Portable — SPOs copy one file to migrate
- Sufficient throughput for expected volume (<100 req/s)
- `better-sqlite3` npm package — synchronous API, no callback complexity

**WAL mode enabled at init:**
```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

### 9.2 Backup

- **Schedule:** Hourly via cron (aligned with existing server backup jobs)
- **Method:** SQLite `.backup()` API → local snapshot, then `rsync` to DR (vduweb62)
- **RPO:** 1 hour (worst case: 1 hour of ledger entries lost)
- **WAL checkpoint before backup:** `PRAGMA wal_checkpoint(TRUNCATE);`
- **Retention:** 7 daily snapshots on primary, 3 on DR
- **Restore:** Copy backup file over `credits.db`, restart API process
- DR: replicate `credits.db` to vduweb62 (same pattern as JSON data files)

### 9.3 Migration

Schema versioning via a `schema_version` table. Engine checks version at
startup and runs migrations forward.

```sql
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 10. Security

### 10.1 Key Security

| Concern | Mitigation |
|---------|-----------|
| Key theft | Keys hashed (SHA-256) before storage — DB leak doesn't expose keys. SHA-256 is sufficient here because API keys have 143 bits of entropy (24 base62 chars), making brute force of the hash computationally infeasible regardless of hash algorithm. HMAC-SHA256 or bcrypt would add no meaningful security given the input entropy. |
| Key in logs | Middleware logs only the prefix (`adv_live_Ab3x****`) — never the full key |
| Key in transit | HTTPS only (Cloudflare + nginx enforce TLS) |
| Brute force | In-memory map tracking failed auth attempts per IP: 5 failures within 60 seconds → block that IP for 15 minutes. This is separate from per-key rate limiting (§8.2 step 4). Map entries expire via a cleanup interval every 5 minutes. Not persisted — resets on restart (acceptable: brute force is a sustained attack). |
| Key rotation | Create new key, migrate credits, revoke old key |

### 10.2 Credit Security

| Concern | Mitigation |
|---------|-----------|
| Double-spend | SQLite transaction wraps reserve/deduct — atomic |
| Race condition | `BEGIN IMMEDIATE` transaction for balance mutations |
| Negative balance | `CHECK (available >= 0)` and `CHECK (reserved >= 0)` constraints in SQL |
| Phantom credits | Append-only ledger — every movement auditable |
| Operator abuse | Ledger entries include provider + reference — traceable |

### 10.3 Operator Key

The admin/operator uses a separate key prefix: `adv_admin_...`

Admin keys can:
- Create/revoke API keys
- Top up any key (manual provider)
- View all keys and balances
- Adjust credits (refunds, corrections)

Admin keys cannot be created via API — only via CLI on the server.

---

## 11. Operational

### 11.1 CLI Tools

```bash
# Key management
npm run credits:create-key -- --name "User name" --env live
npm run credits:list-keys
npm run credits:revoke-key -- --key-prefix "adv_live_Ab3x"
npm run credits:suspend-key -- --key-prefix "adv_live_Ab3x"

# Credit management
npm run credits:topup -- --key-prefix "adv_live_Ab3x" --amount 100 --note "Welcome credits"
npm run credits:balance -- --key-prefix "adv_live_Ab3x"
npm run credits:refund -- --key-prefix "adv_live_Ab3x" --amount 10 --note "Failed tx compensation"

# Reporting
npm run credits:report -- --from 2026-03-01 --to 2026-03-31
npm run credits:ledger -- --key-prefix "adv_live_Ab3x" --limit 50

# Database
npm run credits:migrate        # Run pending migrations
npm run credits:backup          # Backup credits.db
```

### 11.2 Monitoring

- **Balance alerts:** Warn when operator wallet balance < threshold (for on-chain operations)
- **Credit alerts:** Optional webhook when a key's balance drops below configurable threshold
- **Usage dashboard:** `/api/v1/credits/stats` (admin only) — aggregate usage across all keys
- **Health:** Credits engine status included in `/health` response

### 11.3 DR

- `credits.db` synced to DR server (vduweb62) via rsync (same as JSON data files)
- DR API reads from local replica
- Writes only on primary (vduweb42) — DR is read-only for credits
- Failover: if primary down, DR serves read endpoints (balance, usage) but blocks mutations

**Off-chain state acknowledgement:** Credit balances are off-chain state. Unlike
on-chain token balances, they can be lost if backups fail. RPO is 1 hour (§9.2).
In the event of unrecoverable data loss, the append-only ledger can be
reconstructed from payment provider records (Stripe payment IDs, on-chain tx
hashes) and API access logs. This is an accepted trade-off for operational
simplicity — PostgreSQL replication is available as an upgrade path if RPO
requirements tighten.

---

## 12. Phased Delivery

### Phase 1 — Manual Credits (with Notary launch)

**Build:**
- SQLite schema + migrations
- Engine: key validation, balance operations, ledger
- Middleware: Express integration
- Manual provider: CLI tools for key creation and top-up
- API: balance, usage, ledger endpoints

**What it enables:**
- Operator creates keys and allocates credits manually
- Notary API protected by API key + credit check
- Full audit trail of all usage

**Effort:** ~3-4 days

### Phase 2 — Stripe

**Build:**
- Stripe provider: Checkout session creation, webhook handler
- API: top-up endpoint with Stripe redirect
- Web UI: "Buy Credits" button, credit balance display

**Prerequisites:**
- Stripe account (sole trader OK)
- Webhook endpoint accessible from Stripe

**Effort:** ~2-3 days

### Phase 3 — ADA On-Chain

**Build:**
- ADA provider: deposit address generation, Kupo monitor
- API: deposit address endpoint
- Conversion rate configuration

**Prerequisites:**
- Kupo monitoring deposit addresses
- Conversion rate policy (1 ADA = N credits)

**Effort:** ~3-4 days

### Phase 4 — x402

**Build:**
- x402 provider: 402 response generation, payment verification
- Cloudflare integration (proxy-level 402 handling)

**Prerequisites:**
- x402 Cardano/ADA support (not yet available)
- x402 Foundation SDK

**Effort:** ~2-3 days (when x402 Cardano is ready)

---

## 13. Open Items

| # | Item | Status | Owner |
|---|------|--------|-------|
| 1 | Credit-to-ADA conversion rate | TBD — needed for Phase 3 | CxO |
| 2 | Credit pricing per operation | Draft in §3.4 — needs confirmation | CxO |
| 3 | Initial free credit allocation | How many credits for new keys? | CxO |
| 4 | Stripe account setup | Sole trader registration | CxO |
| 5 | Credit expiry policy | Do credits expire? (recommendation: no) | CxO |
| 6 | Self-service key creation (Phase 2) | Email verification? Captcha? Wallet-linked? | Dev team |
| 7 | Multi-currency pricing | Credits priced in GBP, USD, ADA, or abstract units? | CxO |
| 8 | SPO white-label | How much config is environment vs code? | Dev team |
| 9 | Test mode behaviour | Test keys: free, same endpoints, test network only? | Dev team |

---

## Appendix A: Why Not External Billing (Stripe Billing, etc.)

Stripe Billing, Paddle, LemonSqueezy etc. are designed for SaaS subscriptions —
monthly plans, seat-based pricing, invoicing. Our model is **per-operation credits**
(more like OpenAI/Anthropic API billing). Building the credits engine ourselves:

- Avoids subscription model complexity we don't need
- Keeps the ADA on-chain and x402 paths open (no fiat-only lock-in)
- Makes the system portable for other SPOs
- Total build cost is ~3-4 days for Phase 1 — comparable to integrating a billing platform

We still use Stripe as a **payment provider** (Phase 2) — just for the money movement,
not the billing logic.

## Appendix B: Concurrency Model

SQLite with `BEGIN IMMEDIATE` ensures only one writer at a time. For our expected
throughput (<100 req/s), this is sufficient. If we ever need higher throughput:

1. Move to PostgreSQL (swap `store.ts`, keep everything else)
2. Or shard by key prefix (multiple SQLite files)

The engine interface doesn't change — only the store implementation.
