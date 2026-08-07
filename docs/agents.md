# For AI agents — x402-agent-wallet

This is the service an agent asks *before* it spends, and the library that stops it spending when the answer is no.

---

## 1. Discovery

| what | where | for |
|---|---|---|
| `skill.md` | [raw](https://raw.githubusercontent.com/nirholas/x402-agent-wallet/main/skill.md) | Drop into context: routes, prices, verdict schema, every denial reason |
| `/.well-known/x402` | `<BASE_URL>/.well-known/x402` | Machine-readable manifest — resources, prices, input/output schemas, both rails |
| `openapi.json` | repo root | OpenAPI 3.1 including the 402 response |

```bash
curl -s <BASE_URL>/policy | jq   # free: read the rules before proposing a spend
```

## 2. Paying — either rail

Every 402 lists both rails; pick whichever your wallet holds.

```jsonc
{
  "x402Version": 1,
  "accepts": [
    { "scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "1000",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "name": "USDC", "version": "2" } },
    { "scheme": "exact", "network": "solana", "maxAmountRequired": "1000",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": { "name": "USD Coin", "decimals": 6, "feePayer": "2wKup…" } }
  ]
}
```

On Solana, `extra.feePayer` is the facilitator's sponsor: it pays the SOL network fee, so you need **only USDC, no SOL**. See [`examples/agent-client.ts`](https://github.com/nirholas/x402-agent-wallet/blob/main/examples/agent-client.ts) for both flows.

## 3. What you get

A **signed verdict**, in the 200 body:

```jsonc
{
  "verdict": {
    "payload": {
      "verdictId": "verdict_1c2b…", "allowed": false,
      "reason": "amount $0.06 requires approval (threshold $0.05) — supply approvalRef",
      "requiresApproval": true,
      "remainingBudget": { "dailyUsd": 0.94, "railDailyUsd": 0.69 },
      "policyDigest": "3f9c…", "checkedAt": "…"
    },
    "signature": "8b1e…", "algorithm": "HMAC-SHA256"
  }
}
```

**A denial is a 200, not an error.** You paid for the answer, and "no" is the answer. Read `allowed`; do not branch on the status code.

Three fields deserve attention:

- **`requiresApproval: true`** — the spend is not forbidden, it needs a human. Surface it, get an `approvalRef`, retry with it.
- **`remainingBudget`** — plan the rest of the run against this rather than probing until you're refused.
- **`policyDigest`** — binds the verdict to the exact policy that produced it. If the operator changes the rules, old verdicts stop matching, and you can tell.

Verify a verdict without trusting whoever handed it to you:

```bash
curl -s -X POST <BASE_URL>/verify -H 'content-type: application/json' \
  -d '{"payload":{…},"signature":"8b1e…"}'   # → { "valid": true }
```

## 4. Better: enforce it locally

Calling a remote daemon before every payment costs a round trip and $0.001, and it only works if you remember to report what you actually spent. `wrapPayerFetch` closes both gaps — the check runs inside the payment-selection step, so a blocked payment is never signed:

```ts
import { wrapPayerFetch, PolicyViolationError, NoUsableRailError } from "x402-agent-wallet";
import { createSigner } from "x402-fetch";

const payFetch = wrapPayerFetch(fetch, {
  signer: {
    evm: await createSigner("base-sepolia", process.env.EVM_KEY!),
    svm: await createSigner("solana", process.env.SOLANA_KEY!),
  },
  policy: { dailyBudgetUsd: 1, perRequestMaxUsd: 0.05, perRailDailyUsd: { solana: 0.5 } },
});

try {
  const res = await payFetch("https://merchant.example.com/paid");
} catch (err) {
  if (err instanceof PolicyViolationError) { /* budget said no; nothing signed */ }
  if (err instanceof NoUsableRailError)    { /* merchant offers no rail you fund */ }
}
```

Settled spends are recorded automatically from the `X-PAYMENT-RESPONSE` header, so budgets track reality rather than intent.

The policy is evaluated against the **merchant's advertised price** (`maxAmountRequired`), which is the only amount that can be signed — not whatever number your reasoning produced.

## 5. Rails, concretely

| you want | policy |
|---|---|
| Only spend on Base | `allowedRails: ["evm"]` |
| Cap each chain separately | `perRailDailyUsd: { evm: 0.5, solana: 0.5 }` |
| Prefer Solana when both are offered | `preferRail: "solana"` |
| Fail loudly on a chain you don't fund | pass a single signer — `NoUsableRailError` instead of a surprise payment |

## 6. MCP integration

[`examples/mcp-tool.md`](https://github.com/nirholas/x402-agent-wallet/blob/main/examples/mcp-tool.md) exposes `check_spend`, `get_policy` and `get_ledger` as Claude tools, so the model asks before it buys and can explain a denial in the user's terms.

## 7. Getting listed

Deploying this? Register it so other agents can find it:

- **[x402scan.com](https://x402scan.com)** — point it at your `/.well-known/x402`.
- **x402 Bazaar** — the protocol's own resource directory; same manifest format.
- **[agentic.market](https://agentic.market)** — agent-facing marketplace listing.

Keep the manifest accurate: prices, `inputSchema`/`outputSchema`, and both `rails` entries.

---

[Tutorial](./tutorial.md) · [API reference](./api.md) · Contact: nichxbt@gmail.com
