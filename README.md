# x402-agent-wallet

**The spending governor for agents that pay with x402.** Budgets, per-merchant and per-rail caps, approval thresholds — enforced *before* anything is signed, and answered with a verdict you can prove.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![x402](https://img.shields.io/badge/x402-payments-0052ff.svg)](https://x402.org)
[![rails: Base + Solana](https://img.shields.io/badge/rails-Base%20%2B%20Solana-14f195.svg)](#both-rails-always)

```bash
npm install @nirholas/x402-agent-wallet
```

## The problem

Give an agent a funded wallet and an x402 client and it can now spend money in a loop, at machine speed, with no human in the path. The failure modes are not exotic: a retry storm on a $0.05 endpoint, a prompt-injected merchant, a pricing bug that turns $0.001 into $1.00.

`maxValue` in `x402-fetch` caps a *single* payment. That is not a budget. This package is the budget — plus the caps, the allowlists, the approval threshold, and a signed record of every decision.

## Why x402 for this

Per-request payment removes the natural brake that subscriptions provided: with an API key, overspending required a plan change; with x402, it requires nothing at all. The control has to move to the client, per call, before the signature. That is exactly where `wrapPayerFetch` sits.

## Quickstart

```bash
git clone https://github.com/nirholas/x402-agent-wallet && cd x402-agent-wallet
npm install
cp .env.example .env      # already filled in with working defaults
npm run dev
```

```bash
curl -s -X POST localhost:4032/policy-check -H 'content-type: application/json' \
  -d '{"merchant":"api.example.com","amountUsd":0.02}' | jq .accepts   # 402, both rails
npm run client                                                          # pay it, get the verdict
```

## Use it as a library

The important half. The policy check runs **inside** the payment-requirements selection step, so a blocked payment is never signed — nothing on-chain, nothing to refund.

```ts
import { wrapPayerFetch, PolicyViolationError } from "@nirholas/x402-agent-wallet";
import { createSigner } from "x402-fetch";

const payFetch = wrapPayerFetch(fetch, {
  signer: {
    evm: await createSigner("base-sepolia", process.env.EVM_KEY!),
    svm: await createSigner("solana", process.env.SOLANA_KEY!),
  },
  policy: {
    dailyBudgetUsd: 1,
    perRequestMaxUsd: 0.05,
    perMerchantDailyUsd: { "api.example.com": 0.25 },
    perRailDailyUsd: { solana: 0.5 },
    approvalThresholdUsd: 0.02,
    blockedMerchants: ["evil.example"],
    preferRail: "evm",
  },
  onVerdict: (v) => console.log(v.allowed ? "allow" : `deny: ${v.reason}`),
});

try {
  const res = await payFetch("https://api.example.com/paid");
} catch (err) {
  if (err instanceof PolicyViolationError) {
    console.log("blocked:", err.verdict.reason, err.verdict.remainingBudget);
  }
}
```

```
fetch → 402 → choose rail → POLICY CHECK → sign & retry → 200
                                 │
                                 └── PolicyViolationError (nothing was signed)
```

### The public API

| export | what it is |
|---|---|
| `wrapPayerFetch(fetch, { signer, policy, onVerdict?, rails? })` | Policy-enforcing paying fetch. `signer` is one signer or `{ evm, svm }`. |
| `PolicyEngine(policy, { ledgerFile?, ephemeral? })` | The evaluator + spend ledger. `check`, `checkAndLog`, `recordSpend`, `ledger`, `spentTodayUsd`, `railAllowed`, `policyDigest`. |
| `PolicyViolationError` | Thrown instead of paying. Carries the full `verdict`. |
| `NoUsableRailError` | The merchant offered no rail this wallet may use. |
| `railOf(network)` | `"solana…"` → `"solana"`, else `"evm"`. |
| `paywall(routePrices, { service })` | The dual-rail x402 middleware the daemon runs on — reusable in your own server. |
| `sign` / `verify` / `signed` | HMAC-SHA256 over canonical JSON. |

### The policy

```jsonc
{
  "dailyBudgetUsd": 1.0,              // total per UTC day
  "perRequestMaxUsd": 0.1,            // hard ceiling on any single payment
  "approvalThresholdUsd": 0.05,       // at/above this, an approvalRef is required
  "perMerchantDailyUsd": { "api.example.com": 0.25 },
  "perRailDailyUsd": { "evm": 0.75, "solana": 0.75 },
  "allowedMerchants": [],             // non-empty ⇒ allowlist only
  "blockedMerchants": ["evil.example"],
  "allowedNetworks": ["base-sepolia", "base", "solana", "solana-devnet"],
  "allowedRails": ["evm", "solana"],
  "preferRail": "evm"                 // when both are offered
}
```

Only **settled** spends consume budget. Evaluating an intent — allowed or denied — costs nothing, so an agent can ask freely before committing.

## The daemon

Run it when several agents share one budget, or when a supervisor needs an auditable trail.

| route | price | what you get back |
|---|---|---|
| `POST /policy-check` | **$0.001** | Signed verdict: `allowed`, `reason`, `requiresApproval`, every remaining budget, `policyDigest` |
| `POST /record-spend` | free (admin) | Ledger entry for a settled payment |
| `GET /ledger` | free (admin) | Spend history + per-rail totals |
| `GET /policy` | free | The policy in force and its digest |
| `POST /verify` | free | Signature check on a verdict |
| `GET /health` | free | Liveness + advertised rails |

A denial is a **200** with `allowed: false`. You paid for the answer, and "no" is the answer — returning 4xx would take the money and hand back nothing.

Why charge for `/policy-check` at all? A wallet daemon answering unbounded free queries is a denial-of-service target; the price is the rate limit. And `policyDigest` means a verdict is bound to the exact policy that produced it — change the rules and old verdicts stop matching.

## Both rails, always

| rail | network | asset | payTo | facilitator |
|---|---|---|---|---|
| EVM | `base-sepolia` (or `base`) | USDC | `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` | `x402.org/facilitator` |
| Solana | `solana` (or `solana-devnet`) | USDC | `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` | `facilitator.payai.network` |

Policies are rail-aware end to end: `allowedRails` gates which chains the agent may touch, `perRailDailyUsd` caps each independently, `preferRail` picks when both are offered, and the ledger reports `spentTodayByRail`. On Solana the facilitator's `extra.feePayer` sponsors the network fee, so the agent needs only USDC — no SOL.

Set `PAY_TO_ADDRESS` / `SOLANA_PAY_TO_ADDRESS` to receive funds yourself.

## How x402 works here

```
  agent                     wallet daemon                   facilitator
    │  POST /policy-check        │                              │
    │ ──────────────────────────▶│                              │
    │  402 { accepts: [base, solana] }                           │
    │ ◀──────────────────────────│                              │
    │  sign chosen rail          │                              │
    │  POST + X-PAYMENT          │                              │
    │ ──────────────────────────▶│ verify ─────────────────────▶│
    │                            │ settle ─────────────────────▶│
    │  200 { verdict: {payload, signature} } + X-PAYMENT-RESPONSE│
    │ ◀──────────────────────────│                              │
```

## Real backend / API keys

None needed. The policy engine, the ledger and the signing are all real and local — there is no upstream service to key into, and no fixture data anywhere in this repo. The only external calls are to the x402 facilitators that verify and settle payments, and both defaults are free and keyless.

`ADMIN_KEY` guards `/ledger` and `/record-spend`; `SIGNING_SECRET` signs verdicts. Both have dev defaults and both must be set before you expose the daemon.

## For AI agents

- **`skill.md`** — the agent-facing contract: endpoints, prices, verdict schema, every denial reason.
- **`/.well-known/x402`** — machine-readable manifest, served by the app and committed at `public/.well-known/x402`.
- **`openapi.json`** — OpenAPI 3.1 including the 402 response and `PaymentRequirements`.
- **MCP** — `examples/mcp-tool.md` exposes `check_spend` as a Claude tool, so the model asks before it buys.
- **Discovery** — list your deployment on [x402scan.com](https://x402scan.com), the x402 Bazaar, and [agentic.market](https://agentic.market).

## Docs

Full docs: **https://nirholas.github.io/x402-agent-wallet/** — [tutorial](https://nirholas.github.io/x402-agent-wallet/tutorial), [API reference](https://nirholas.github.io/x402-agent-wallet/api), [for agents](https://nirholas.github.io/x402-agent-wallet/agents).

## Support

Questions, bugs, integrations: **nichxbt@gmail.com**

Part of the [x402 Suite](https://github.com/nirholas/x402-suite).

## License

Apache-2.0 — see [LICENSE](./LICENSE).

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=nirholas/x402-agent-wallet&type=Date)](https://www.star-history.com/#nirholas/x402-agent-wallet&Date)

<!-- three.ws:growth -->
## Support the project

If x402-agent-wallet saves you time, **[star it on GitHub](https://github.com/nirholas/x402-agent-wallet)**. Stars are how other developers and AI agents find the repositories worth trusting, and they cost you one click.

Know someone who would use it? [Post on X](https://twitter.com/intent/tweet?text=x402-agent-wallet%3A%20Wallet%20policy%20daemon%20for%20agents%3A%20budgets%2C%20per-merchant%20caps%2C%20approval%20thresholds%2C%20signed%20policy&url=https%3A%2F%2Fgithub.com%2Fnirholas%2Fx402-agent-wallet) · [Share on Bluesky](https://bsky.app/intent/compose?text=x402-agent-wallet%3A%20Wallet%20policy%20daemon%20for%20agents%3A%20budgets%2C%20per-merchant%20caps%2C%20approval%20thresholds%2C%20signed%20policy%20https%3A%2F%2Fgithub.com%2Fnirholas%2Fx402-agent-wallet) · [Share on LinkedIn](https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fgithub.com%2Fnirholas%2Fx402-agent-wallet) · [Submit to Hacker News](https://news.ycombinator.com/submitlink?u=https%3A%2F%2Fgithub.com%2Fnirholas%2Fx402-agent-wallet&t=x402-agent-wallet%3A%20Wallet%20policy%20daemon%20for%20agents%3A%20budgets%2C%20per-merchant%20caps%2C%20approval%20thresholds%2C%20signed%20policy) · [Share on Reddit](https://www.reddit.com/submit?url=https%3A%2F%2Fgithub.com%2Fnirholas%2Fx402-agent-wallet&title=x402-agent-wallet%3A%20Wallet%20policy%20daemon%20for%20agents%3A%20budgets%2C%20per-merchant%20caps%2C%20approval%20thresholds%2C%20signed%20policy)

## Built for AI agents too

Coding agents and LLM tooling can read this repo directly: [AGENTS.md](./AGENTS.md), [llms.txt](./llms.txt), [llms-full.txt](./llms-full.txt). Point an agent at `https://github.com/nirholas/x402-agent-wallet` and it has the context it needs.

## More from the same author

- [All repositories by nirholas](https://github.com/nirholas/nirholas#readme): the full catalog, grouped by topic
- [three.ws](https://three.ws): the platform for 3D AI agents with Solana wallets, a skill marketplace and x402 payments
- Questions or ideas: [open an issue](https://github.com/nirholas/x402-agent-wallet/issues) or [start a discussion](https://github.com/nirholas/x402-agent-wallet/discussions)

## Contributors

[![Contributors](https://contrib.rocks/image?repo=nirholas/x402-agent-wallet)](https://github.com/nirholas/x402-agent-wallet/graphs/contributors)

<!-- /three.ws:growth -->
