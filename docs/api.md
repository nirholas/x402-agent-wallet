# API reference — x402-agent-wallet

Two surfaces: the **library** (the recommended one — enforcement before signing) and the **daemon's HTTP API** (for shared budgets and audit trails).

- Machine-readable: [`openapi.json`](https://github.com/nirholas/x402-agent-wallet/blob/main/openapi.json) · [`/.well-known/x402`](https://github.com/nirholas/x402-agent-wallet/blob/main/public/.well-known/x402)
- Agent-facing summary: [`skill.md`](https://github.com/nirholas/x402-agent-wallet/blob/main/skill.md)

---

## Library API

```ts
import {
  wrapPayerFetch, PolicyViolationError, NoUsableRailError,
  PolicyEngine, railOf, paywall, paymentReceipt,
  sign, verify, signed,
} from "x402-agent-wallet";
```

### `wrapPayerFetch(baseFetch, options)`

Returns a fetch-shaped function that enforces the policy inside x402's payment-requirements selection.

| option | type | notes |
|---|---|---|
| `signer` | `Signer \| { evm, svm }` | One signer, or both rails. Use `createSigner()` from `x402-fetch`. |
| `policy` | `WalletPolicy \| PolicyEngine` | Pass an engine to share a ledger across call sites. |
| `onVerdict` | `(v: PolicyVerdict) => void` | Called for every decision, allowed or not. |
| `rails` | `("evm" \| "solana")[]` | Rails this signer can sign for. Inferred from a `{ evm, svm }` signer. |

Selection order: filter `accepts` down to rails the signer supports **and** `policy.allowedRails` permits → prefer `policy.preferRail` → evaluate → sign or throw.

Throws `PolicyViolationError` (carries `.verdict`) when the policy says no, and `NoUsableRailError` (carries `.offered`) when the merchant offers nothing this wallet may pay on. In both cases **nothing was signed**.

On a successful 200 with an `X-PAYMENT-RESPONSE` header, the spend is recorded automatically.

### `WalletPolicy`

| field | type | default | meaning |
|---|---|---|---|
| `dailyBudgetUsd` | number | required | Total per UTC day |
| `perRequestMaxUsd` | number | required | Hard ceiling on one payment; also caps what x402-fetch may sign |
| `approvalThresholdUsd` | number | — | At/above this, an `approvalRef` is required |
| `perMerchantDailyUsd` | `Record<host, number>` | — | Per-merchant daily caps |
| `perRailDailyUsd` | `{ evm?, solana? }` | — | Per-rail daily caps |
| `allowedMerchants` | string[] | — | Non-empty ⇒ allowlist only |
| `blockedMerchants` | string[] | — | Never payable |
| `allowedNetworks` | string[] | any | Exact network names |
| `allowedRails` | `("evm"\|"solana")[]` | both | Which chains this treasury funds |
| `preferRail` | `"evm" \| "solana"` | merchant's order | Tie-break when both are offered |

Merchant strings are normalised to a host (`https://api.example.com/x` → `api.example.com`).

### `PolicyEngine`

```ts
const engine = new PolicyEngine(policy, { ledgerFile: "data/spend-ledger.json" });
// or { ephemeral: true } for in-memory
```

| method | returns | notes |
|---|---|---|
| `check(intent)` | `PolicyVerdict` | Pure evaluation, records nothing |
| `checkAndLog(intent)` | `PolicyVerdict` | Also writes an `approved-intent` / `denied-intent` entry |
| `recordSpend({ merchant, amountUsd, resource?, network?, rail?, verdictId? })` | `SpendEntry` | The only thing that consumes budget |
| `ledger()` | `SpendEntry[]` | Newest first |
| `spentTodayUsd({ merchant?, rail? })` | number | UTC day; `spend` entries only |
| `railAllowed(rail)` | boolean | Against `allowedRails` |
| `policyDigest()` | string | HMAC of the policy — binds verdicts to the rules that produced them |
| `policy` | `WalletPolicy` | The policy in force |

Writes are atomic (temp file + rename). `validatePolicy` throws on a negative or non-numeric budget.

### `SpendIntent` / `PolicyVerdict`

```ts
interface SpendIntent {
  merchant: string;        // host or URL
  amountUsd: number;
  resource?: string;
  network?: string;        // base-sepolia | base | solana | solana-devnet
  rail?: "evm" | "solana"; // derived from network when omitted
  approvalRef?: string;
}

interface PolicyVerdict {
  verdictId: string;
  allowed: boolean;
  reason: string;
  requiresApproval: boolean;
  intent: SpendIntent;
  remainingBudget: { dailyUsd: number; merchantDailyUsd?: number; railDailyUsd?: number };
  policyDigest: string;
  checkedAt: string;
}
```

### Denial reasons

| reason | trigger |
|---|---|
| `invalid amount` | Negative or non-numeric `amountUsd` |
| `merchant X is blocked` | `blockedMerchants` |
| `merchant X is not on the allowlist` | `allowedMerchants` non-empty and X absent |
| `network X is not allowed` | `allowedNetworks` |
| `rail X is not allowed (allowedRails: …)` | `allowedRails` |
| `amount $X exceeds per-request max $Y` | `perRequestMaxUsd` |
| `daily budget exhausted ($X of $Y spent)` | `dailyBudgetUsd` |
| `merchant daily cap exhausted for H ($X of $Y)` | `perMerchantDailyUsd` |
| `X rail daily cap exhausted ($A of $B)` | `perRailDailyUsd` |
| `amount $X requires approval (threshold $Y) — supply approvalRef` | `approvalThresholdUsd`, sets `requiresApproval: true` |

Checks run in that order, so the first structural objection wins over a budget one.

### `paywall(routePrices, { service, baseUrl? })`

The dual-rail x402 middleware the daemon runs on, exported for reuse. `{ "POST /policy-check": "$0.001" }`; paths support `:param`, `*`, `**`. Routes absent from the map are free. Emits a 402 with one `accepts` entry per rail, verifies and settles through that rail's facilitator, sets `X-PAYMENT-RESPONSE`, then `next()`.

### `paymentReceipt(res)`

`{ success, rail, network, transaction, payer, amount, asset, resource }` for the current request, or `null` on free routes.

### Signing

```ts
sign(payload, secret?)              // hex HMAC-SHA256 over canonical JSON
verify(payload, signature, secret?) // constant-time
signed(payload)                     // { payload, signature, algorithm }
canonicalize(value)                 // deterministic JSON, keys sorted recursively
```

`SIGNING_SECRET`, with a public dev default. Set it or verdicts are forgeable.

---

## HTTP API

Base URL: `http://localhost:4021` in dev.

### `POST /policy-check` — $0.001

Body: `SpendIntent` (`merchant` and `amountUsd` required).

```jsonc
{
  "verdict": {
    "payload": { "verdictId": "verdict_1c2b…", "allowed": true, "reason": "within policy",
                 "requiresApproval": false, "intent": { … },
                 "remainingBudget": { "dailyUsd": 0.94, "merchantDailyUsd": 0.21, "railDailyUsd": 0.69 },
                 "policyDigest": "3f9c…", "checkedAt": "…" },
    "signature": "8b1e…", "algorithm": "HMAC-SHA256"
  },
  "paidWith": { "rail": "evm", "network": "base-sepolia", "transaction": "0x…", "payer": "0x9a…" }
}
```

**400** when `merchant` or `amountUsd` is missing. A *denial* is a 200 with `allowed: false`.

### `POST /record-spend` — free, `X-Admin-Key`

Body `{ merchant, amountUsd, resource?, network?, verdictId? }` → `{ entry, spentTodayUsd }`.

### `GET /ledger` — free, `X-Admin-Key`

```jsonc
{ "policy": { … }, "policyDigest": "3f9c…", "spentTodayUsd": 0.06,
  "spentTodayByRail": { "evm": 0.04, "solana": 0.02 },
  "entries": [ { "id": "entry_…", "kind": "spend", "merchant": "api.example.com",
                 "amountUsd": 0.02, "network": "base-sepolia", "rail": "evm",
                 "verdictId": "verdict_…", "at": "…" } ] }
```

`kind` ∈ `spend` (counts against budgets) · `approved-intent` · `denied-intent` (do not).

### `GET /policy` — free

`{ policy, policyDigest, spentTodayUsd }`.

### `POST /verify` — free

`{ payload, signature }` → `{ valid: boolean }`.

### `GET /health` — free

`{ ok, service, rails: [ { rail, network, payTo, facilitator } ] }`.

### `GET /.well-known/x402` — free

Discovery manifest: resources, prices, input/output schemas, both rails.

### Error cases

| status | body | when |
|---|---|---|
| 402 | `{ x402Version, error, accepts[] }` | No/invalid/unsupported payment |
| 400 | `{ error: "BAD_REQUEST", hint }` | Missing required fields |
| 401 | `{ error: "UNAUTHORIZED", hint }` | Bad or missing `X-Admin-Key` |
| 500 | `{ error: "no_payment_rail" }` | Neither rail has a valid payTo |
| 502 | `{ error: "facilitator_unreachable" \| "settlement_error" }` | Facilitator down; not charged |

---

[Tutorial](./tutorial.md) · [For AI agents](./agents.md)
