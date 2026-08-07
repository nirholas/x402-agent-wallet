# Tutorial — x402-agent-wallet

Run the daemon, buy a signed verdict, then move enforcement to where it belongs: inside the client, before anything is signed.

---

## 1. Install

```bash
git clone https://github.com/nirholas/x402-agent-wallet
cd x402-agent-wallet
npm install
cp .env.example .env
```

Node 18+. The `.env.example` ships with working defaults on both rails, so nothing needs configuring to try it.

## 2. Write a policy

`config/policy.json` is the whole ruleset:

```jsonc
{
  "dailyBudgetUsd": 1.0,              // total per UTC day
  "perRequestMaxUsd": 0.1,            // hard ceiling on any single payment
  "approvalThresholdUsd": 0.05,       // at/above this, an approvalRef is required
  "perMerchantDailyUsd": { "localhost:4021": 0.25 },
  "perRailDailyUsd": { "evm": 0.75, "solana": 0.75 },
  "allowedMerchants": [],             // non-empty ⇒ allowlist only
  "blockedMerchants": ["evil.example"],
  "allowedNetworks": ["base-sepolia", "base", "solana", "solana-devnet"],
  "allowedRails": ["evm", "solana"],
  "preferRail": "evm"
}
```

Two things worth internalising:

- **Only settled spends consume budget.** Evaluating an intent costs nothing, so an agent can ask freely before committing.
- **Budget windows are UTC days.** Not rolling 24h. `spentTodayUsd` resets at midnight UTC.

## 3. Run the daemon

```bash
npm run dev
```

```
x402-agent-wallet daemon on http://localhost:4021

Payment rails (client picks one):
  evm     base-sepolia   USDC → 0x40252CFDF8B20Ed757D61ff157719F33Ec332402
  solana  solana         USDC → WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW

Policy: config/policy.json
  daily budget      $1
  per-request max   $0.1
  approval above    $0.05
  allowed rails     evm, solana
  spent today       $0
```

## 4. Read the rules before you spend

```bash
curl -s localhost:4021/policy | jq
```

Free, so an agent can orient itself without paying. `policyDigest` is an HMAC of the policy — remember it; verdicts carry it, and it changes when the operator changes the rules.

## 5. Your first 402

```bash
curl -s -X POST localhost:4021/policy-check \
  -H 'content-type: application/json' \
  -d '{"merchant":"api.example.com","amountUsd":0.02}' | jq .accepts
```

```jsonc
[
  { "scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "1000",
    "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402", "…": "…" },
  { "scheme": "exact", "network": "solana", "maxAmountRequired": "1000",
    "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW", "…": "…" }
]
```

`1000` atomic units = $0.001. Two entries, one per rail.

## 6. Pay for a verdict

Fund a Base Sepolia wallet at [faucet.circle.com](https://faucet.circle.com), then:

```bash
PRIVATE_KEY=0xyourTestKey npm run client
```

```jsonc
{
  "payload": {
    "verdictId": "verdict_1c2b…",
    "allowed": true,
    "reason": "within policy",
    "requiresApproval": false,
    "intent": { "merchant": "api.example.com", "amountUsd": 0.02, "rail": "evm" },
    "remainingBudget": { "dailyUsd": 1, "railDailyUsd": 0.75 },
    "policyDigest": "3f9c…",
    "checkedAt": "2026-08-07T16:00:00.000Z"
  },
  "signature": "8b1e…",
  "algorithm": "HMAC-SHA256"
}
```

The example then calls `/verify` and prints `Signature valid: true`. That signature is the point: the agent can show a supervisor exactly what it was authorised to do, and the supervisor can check it without trusting the agent.

## 7. Get denied

Denials are `200`s. You paid for the answer, and "no" is the answer.

```bash
# Above the per-request ceiling
-d '{"merchant":"api.example.com","amountUsd":0.4}'
# → allowed: false, "amount $0.4 exceeds per-request max $0.1"

# Above the approval threshold, no sign-off
-d '{"merchant":"api.example.com","amountUsd":0.06}'
# → allowed: false, requiresApproval: true,
#   "amount $0.06 requires approval (threshold $0.05) — supply approvalRef"

# Same spend, with sign-off
-d '{"merchant":"api.example.com","amountUsd":0.06,"approvalRef":"slack-approval-8812"}'
# → allowed: true, "within policy (approved via slack-approval-8812)"

# Blocked merchant
-d '{"merchant":"evil.example","amountUsd":0.001}'
# → allowed: false, "merchant evil.example is blocked"

# Rail the treasury doesn't fund (with allowedRails: ["evm"])
-d '{"merchant":"api.example.com","amountUsd":0.01,"network":"solana"}'
# → allowed: false, "rail solana is not allowed (allowedRails: evm)"
```

## 8. Keep the ledger honest

The daemon only knows about spends you tell it about:

```bash
curl -s -X POST localhost:4021/record-spend -H 'X-Admin-Key: dev-admin-key' \
  -H 'content-type: application/json' \
  -d '{"merchant":"api.example.com","amountUsd":0.02,"network":"base-sepolia","verdictId":"verdict_1c2b…"}' | jq

curl -s localhost:4021/ledger -H 'X-Admin-Key: dev-admin-key' | jq '{spentTodayUsd, spentTodayByRail}'
# { "spentTodayUsd": 0.02, "spentTodayByRail": { "evm": 0.02, "solana": 0 } }
```

That gap — check here, spend there, remember to report back — is exactly why the library version is better.

## 9. Move enforcement into the client

```ts
import { wrapPayerFetch, PolicyViolationError } from "x402-agent-wallet";
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
    preferRail: "evm",
  },
  onVerdict: (v) => console.log(v.allowed ? "allow" : `deny: ${v.reason}`),
});

try {
  const res = await payFetch("https://api.example.com/paid");
  console.log(await res.json());
} catch (err) {
  if (err instanceof PolicyViolationError) {
    console.log("blocked:", err.verdict.reason, err.verdict.remainingBudget);
  }
}
```

Three things this buys you over the daemon:

1. **The check is before the signature.** A blocked payment never settles, so there is nothing to refund and no on-chain trace.
2. **The ledger updates itself.** A settled payment is recorded when `X-PAYMENT-RESPONSE` comes back on the 200 — no reporting step to forget.
3. **It costs nothing per call.**

The policy is evaluated against the merchant's advertised price (`maxAmountRequired` in the 402), which is the only amount that can actually be signed — not whatever number your code had in mind.

## 10. Rails in practice

```ts
// A treasury funded only on Base:
policy: { allowedRails: ["evm"], … }
// A Solana-only merchant now raises NoUsableRailError instead of quietly
// paying on a chain you didn't fund.

// Spread risk across chains:
policy: { perRailDailyUsd: { evm: 0.5, solana: 0.5 }, preferRail: "solana" }
```

If you pass a single signer rather than `{ evm, svm }`, only that rail is selectable — `wrapPayerFetch` will not try to sign on a chain the wallet can't serve.

## 11. Going to production

```bash
NETWORK=base
SOLANA_NETWORK=mainnet-beta
FACILITATOR_URL=https://facilitator.payai.network
SOLANA_FACILITATOR_URL=https://facilitator.payai.network
PAY_TO_ADDRESS=0xYourRealWallet
SOLANA_PAY_TO_ADDRESS=YourRealSolanaWallet
ADMIN_KEY=$(openssl rand -hex 32)
SIGNING_SECRET=$(openssl rand -hex 32)
```

Checklist:

- **Set `SIGNING_SECRET`.** Otherwise verdicts are signed with a public dev key and anyone can forge an approval.
- **Set `ADMIN_KEY`.** `/ledger` reveals everything the agent has bought.
- **Persist `data/spend-ledger.json`** on a volume, or budgets reset on every deploy.
- **Set `PUBLIC_BASE_URL`** so the `resource` in each 402 matches the URL clients call — facilitators check it.
- **Treat `approvalThresholdUsd` as a real workflow.** An `approvalRef` nobody ever issues is just a spending cap with extra steps.

---

Next: [API reference](./api.md) · [For AI agents](./agents.md)
