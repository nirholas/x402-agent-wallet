---
name: agent-wallet-policy
description: Enforce an agent spending policy (daily budget, per-request ceiling, merchant and rail caps, approval threshold) before an x402 payment is signed, either in process with wrapPayerFetch or through the policy daemon. Use when an agent pays for APIs and needs hard limits and signed proof of authorization.
---

# x402-agent-wallet

Answers one question for a paying agent: may I spend this? It is both a library
(npm package `@nirholas/x402-agent-wallet`) and a daemon that returns
HMAC-signed verdicts.

## In-process enforcement

```bash
npm install @nirholas/x402-agent-wallet
```

```ts
import { wrapPayerFetch, PolicyViolationError } from "@nirholas/x402-agent-wallet";

const payFetch = wrapPayerFetch(fetch, {
  signer: { evm: evmSigner, svm: solanaSigner },
  policy: { dailyBudgetUsd: 1, perRequestMaxUsd: 0.05, perRailDailyUsd: { solana: 0.5 } },
});
await payFetch("https://api.example.com/paid");   // throws PolicyViolationError when blocked
```

The check runs before anything is signed, so a blocked payment never touches a
chain. `WalletPolicy` fields: `dailyBudgetUsd`, `perRequestMaxUsd`,
`approvalThresholdUsd`, `perMerchantDailyUsd`, `allowedMerchants`,
`blockedMerchants`, `allowedNetworks`, `allowedRails` (`"evm"` or `"solana"`),
`preferRail`, `perRailDailyUsd`. Other exports include `NoUsableRailError`; an
`onVerdict` callback receives every verdict for audit logs.

## Daemon

## Run the server

It is a self-hosted Node server (Express, Node 18 or newer). Run it from a clone:

```bash
git clone https://github.com/nirholas/x402-agent-wallet && cd x402-agent-wallet
npm install
cp .env.example .env     # then adjust; see the comments in the file
npm run dev              # tsx src/server.ts, listens on PORT (default 4032)
```

`npm run build` then `npm start` runs the compiled server. `npm run client`
runs `examples/agent-client.ts`, a reference paying client. Set `PAY_TO_ADDRESS`
and `SOLANA_PAY_TO_ADDRESS` to your own wallets to be paid yourself.

The policy is read from `POLICY_FILE` (default `config/policy.json`), the ledger
is stored at `LEDGER_FILE`, and `ADMIN_KEY` guards the admin routes (default
`dev-admin-key`: change it).

| Route | Price | Purpose |
| --- | --- | --- |
| `POST /policy-check` | $0.001 | body `merchant`, `amountUsd`, optional `resource`, `network`, `rail`, `approvalRef`. Returns a signed `verdict` |
| `GET /policy` | free | the rules and `policyDigest` |
| `GET /ledger` | free, `X-Admin-Key` | spend entries and totals |
| `POST /record-spend` | free, `X-Admin-Key` | body `merchant`, `amountUsd`, optional `resource`, `network`, `verdictId` |
| `POST /verify` | free | body `{ payload, signature }`, returns `{ valid }` |
| `GET /health`, `GET /.well-known/x402` | free | |

A denial is still HTTP 200 with `allowed: false` and a `reason` (budget
exhausted, merchant blocked, amount over ceiling). When `requiresApproval` is
true, resubmit with an `approvalRef` from a human sign-off.

## Paying (x402)

Paid routes follow the x402 protocol. An unpaid call returns HTTP 402 with an
`accepts` array listing USDC on Base and USDC on Solana. Sign for one rail,
retry with the base64 payload in the `X-PAYMENT` header, and the 200 body
carries the result; the settlement receipt is in the `X-PAYMENT-RESPONSE`
header. Clients: `x402-fetch` (EVM), `@three-ws/x402-payment-modal` (browser,
both rails), or any x402 client. The rail networks are chosen by `NETWORK`
(EVM, `base-sepolia` by default) and `SOLANA_NETWORK` in `.env`; see
`.env.example`. Settlement moves real USDC on the chosen network: show the user
the recipient, amount and network and get an explicit yes before every paid call.
