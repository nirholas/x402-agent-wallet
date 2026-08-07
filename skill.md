# Skill: x402-agent-wallet

## What this service does

`x402-agent-wallet` is the spending governor for an agent that pays with x402. It holds a **WalletPolicy** — daily budget, per-request ceiling, per-merchant and per-rail caps, an approval threshold, merchant allow/block lists — and answers one question: *may I spend this?* The answer comes back **HMAC-signed**, so the agent can prove to a supervisor exactly what it was authorised to do. The npm package also exports `wrapPayerFetch()`, which enforces the same policy locally, *before* anything is signed.

**Payment: USDC on Base or Solana — your client picks the rail.** Every 402 lists both.

## Base URL

```
<BASE_URL>          # e.g. http://localhost:4021, or your deployment
```

## Endpoints

### POST /policy-check — $0.001

Evaluate a proposed spend.

**Body**

| field | type | required | meaning |
|---|---|---|---|
| `merchant` | string | yes | Merchant host or full URL (normalised to a host) |
| `amountUsd` | number | yes | Proposed spend in USD |
| `resource` | string | no | Resource URL being purchased |
| `network` | string | no | `base-sepolia` \| `base` \| `solana` \| `solana-devnet` |
| `rail` | `"evm"` \| `"solana"` | no | Derived from `network` when omitted |
| `approvalRef` | string | no | Supervisor sign-off id, required above `approvalThresholdUsd` |

**Response 200**

```jsonc
{
  "verdict": {
    "payload": {
      "verdictId": "verdict_1c2b…",
      "allowed": true,
      "reason": "within policy",
      "requiresApproval": false,
      "intent": { "merchant": "api.example.com", "amountUsd": 0.02, "rail": "evm" },
      "remainingBudget": { "dailyUsd": 0.94, "merchantDailyUsd": 0.21, "railDailyUsd": 0.69 },
      "policyDigest": "3f9c…",
      "checkedAt": "2026-08-07T16:00:00.000Z"
    },
    "signature": "8b1e…",
    "algorithm": "HMAC-SHA256"
  },
  "paidWith": { "rail": "evm", "network": "base-sepolia", "transaction": "0x…", "payer": "0x9a…" }
}
```

A denial is still a **200** with `allowed: false` — you paid for the answer, and "no" is the answer. Typical reasons:

- `amount $0.4 exceeds per-request max $0.1`
- `daily budget exhausted ($0.97 of $1 spent)`
- `merchant daily cap exhausted for api.example.com ($0.25 of $0.25)`
- `solana rail daily cap exhausted ($0.75 of $0.75)`
- `rail solana is not allowed (allowedRails: evm)`
- `merchant evil.example is blocked`
- `amount $0.06 requires approval (threshold $0.05) — supply approvalRef` → `requiresApproval: true`

`policyDigest` is an HMAC of the policy that produced the verdict: if the operator changes the policy, old verdicts no longer match, and you can tell.

### GET /ledger — free, requires `X-Admin-Key`

```jsonc
{
  "policy": { … }, "policyDigest": "3f9c…",
  "spentTodayUsd": 0.06,
  "spentTodayByRail": { "evm": 0.04, "solana": 0.02 },
  "entries": [ { "id": "entry_…", "kind": "spend", "merchant": "api.example.com",
                 "amountUsd": 0.02, "rail": "evm", "at": "…" } ]
}
```

`kind` ∈ `spend` (settled, counts against budgets) · `approved-intent` · `denied-intent` (evaluations, which do **not** consume budget).

### POST /record-spend — free, requires `X-Admin-Key`

Body `{ merchant, amountUsd, resource?, network?, verdictId? }` → `{ entry, spentTodayUsd }`. Tells the daemon a payment actually settled. Client-side `wrapPayerFetch` does this automatically for its own ledger.

### GET /policy — free

`{ policy, policyDigest, spentTodayUsd }` — read the rules before proposing a spend.

### POST /verify — free

Body `{ payload, signature }` → `{ valid: true|false }`. Verifies a verdict.

### GET /health — free

`{ ok: true, service, rails: [ … ] }`.

## Payment

- Protocol: **x402**, `scheme: "exact"`, `x402Version: 1`.
- Asset: **USDC** (6 decimals) on both rails.
- Rails in every 402 `accepts` array:
  - `network: "base-sepolia"` (or `base`), payTo `0x40252CFDF8B20Ed757D61ff157719F33Ec332402`, facilitator `https://x402.org/facilitator`.
  - `network: "solana"` (or `solana-devnet`), payTo `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`, facilitator `https://facilitator.payai.network`. `extra.feePayer` sponsors the SOL fee, so you need only USDC.
- Pay with `x402-fetch`, `@three-ws/x402-payment-modal`, or any x402 client.
- The 200 carries `X-PAYMENT-RESPONSE` (base64 JSON) with rail, network, transaction and payer.

## Using the library instead

Cheaper and safer than calling the daemon per spend — the check happens before signing, so a blocked payment never touches a chain:

```ts
import { wrapPayerFetch } from "x402-agent-wallet";

const payFetch = wrapPayerFetch(fetch, {
  signer: { evm: evmSigner, svm: solanaSigner },
  policy: { dailyBudgetUsd: 1, perRequestMaxUsd: 0.05, perRailDailyUsd: { solana: 0.5 } },
});

await payFetch("https://api.example.com/paid");   // throws PolicyViolationError if blocked
```

## Error codes

| status | body `error` | meaning |
|---|---|---|
| 402 | `X-PAYMENT header is required` | Unpaid. Read `accepts`, pay, retry. |
| 402 | `invalid X-PAYMENT header: …` | Malformed base64/JSON payload. |
| 402 | `unsupported rail: …` | You signed for a network this endpoint does not accept. |
| 402 | `payment rejected: …` / `settlement failed: …` | Facilitator refused or could not settle. Not charged. |
| 400 | `BAD_REQUEST` | Missing `merchant` / `amountUsd`, or `/verify` without `payload` + `signature`. |
| 401 | `UNAUTHORIZED` | `/ledger` or `/record-spend` without a valid `X-Admin-Key`. |
| 500 | `no_payment_rail` | Server misconfigured: no valid payTo on either rail. |
| 502 | `facilitator_unreachable` / `settlement_error` | Facilitator down. Retry; you were not charged. |

## Discovery

- Manifest: `<BASE_URL>/.well-known/x402`
- Docs: https://nirholas.github.io/x402-agent-wallet/
- Source: https://github.com/nirholas/x402-agent-wallet
- Contact: nichxbt@gmail.com
