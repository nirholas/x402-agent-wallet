# Raw curl walkthrough — 402 → pay → 200

Against `npm run dev` on `localhost:4032`.

## 1. Free routes first

An agent should orient itself before spending anything:

```bash
curl -s localhost:4032/policy | jq
```

```jsonc
{
  "policy": {
    "dailyBudgetUsd": 1, "perRequestMaxUsd": 0.1, "approvalThresholdUsd": 0.05,
    "perMerchantDailyUsd": { "localhost:4032": 0.25 },
    "perRailDailyUsd": { "evm": 0.75, "solana": 0.75 },
    "allowedRails": ["evm", "solana"], "preferRail": "evm"
  },
  "policyDigest": "3f9c…",
  "spentTodayUsd": 0
}
```

## 2. Ask without paying

```bash
curl -i -s -X POST localhost:4032/policy-check \
  -H 'content-type: application/json' \
  -d '{"merchant":"api.example.com","amountUsd":0.02}'
```

```http
HTTP/1.1 402 Payment Required
Access-Control-Expose-Headers: x-payment-response
```

```jsonc
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [
    {
      "scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "1000",
      "resource": "http://localhost:4032/policy-check",
      "description": "x402-agent-wallet: POST /policy-check",
      "mimeType": "application/json",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "maxTimeoutSeconds": 60,
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "name": "USDC", "version": "2" }
    },
    {
      "scheme": "exact", "network": "solana", "maxAmountRequired": "1000",
      "resource": "http://localhost:4032/policy-check",
      "description": "x402-agent-wallet: POST /policy-check",
      "mimeType": "application/json",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "maxTimeoutSeconds": 60,
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": { "name": "USD Coin", "decimals": 6, "feePayer": "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4", "amount": "1000" }
    }
  ]
}
```

`1000` atomic USDC units = $0.001. Two rails, same price.

```bash
curl -s -X POST localhost:4032/policy-check -H 'content-type: application/json' \
  -d '{"merchant":"api.example.com","amountUsd":0.02}' \
  | jq -r '.accepts[] | "\(.network)\t$\(.maxAmountRequired|tonumber/1000000)\t\(.payTo)"'
```

## 3. Pay

Signing needs a wallet, so produce the header with an x402 client (`npm run client`, or see [`agent-client.ts`](./agent-client.ts)) and pass it through:

```bash
curl -i -s -X POST localhost:4032/policy-check \
  -H 'content-type: application/json' \
  -H "X-PAYMENT: $X_PAYMENT" \
  -d '{"merchant":"api.example.com","amountUsd":0.02}'
```

```http
HTTP/1.1 200 OK
X-PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLCJyYWlsIjoiZXZtIiwi…
```

```jsonc
{
  "verdict": {
    "payload": { "verdictId": "verdict_1c2b…", "allowed": true, "reason": "within policy",
                 "requiresApproval": false,
                 "remainingBudget": { "dailyUsd": 1, "railDailyUsd": 0.75 },
                 "policyDigest": "3f9c…", "checkedAt": "…" },
    "signature": "8b1e…", "algorithm": "HMAC-SHA256"
  },
  "paidWith": { "rail": "evm", "network": "base-sepolia", "transaction": "0x…", "payer": "0x9a…" }
}
```

```bash
echo 'eyJzdWNjZXNzIjp0cnVlLCJyYWlsIjoiZXZtIiwi…' | base64 -d | jq
```

## 4. Every way to be told no

All of these are **200**s with `allowed: false` — you paid for the answer.

```bash
P='-H content-type:application/json -H'   # shorthand for the payment header below

# Over the per-request ceiling
-d '{"merchant":"api.example.com","amountUsd":0.4}'
# → "amount $0.4 exceeds per-request max $0.1"

# Needs a human
-d '{"merchant":"api.example.com","amountUsd":0.06}'
# → requiresApproval: true, "amount $0.06 requires approval (threshold $0.05) — supply approvalRef"

# Same spend, signed off
-d '{"merchant":"api.example.com","amountUsd":0.06,"approvalRef":"slack-approval-8812"}'
# → allowed: true, "within policy (approved via slack-approval-8812)"

# Blocked merchant
-d '{"merchant":"evil.example","amountUsd":0.001}'
# → "merchant evil.example is blocked"

# Rail the treasury doesn't fund (policy allowedRails: ["evm"])
-d '{"merchant":"api.example.com","amountUsd":0.01,"network":"solana"}'
# → "rail solana is not allowed (allowedRails: evm)"
```

Verify any verdict:

```bash
curl -s -X POST localhost:4032/verify -H 'content-type: application/json' \
  -d '{"payload":{…},"signature":"8b1e…"}' | jq
# { "valid": true }
```

## 5. The ledger

```bash
# Record what actually settled
curl -s -X POST localhost:4032/record-spend \
  -H 'X-Admin-Key: dev-admin-key' -H 'content-type: application/json' \
  -d '{"merchant":"api.example.com","amountUsd":0.02,"network":"base-sepolia"}' | jq

curl -s localhost:4032/ledger -H 'X-Admin-Key: dev-admin-key' \
  | jq '{spentTodayUsd, spentTodayByRail}'
# { "spentTodayUsd": 0.02, "spentTodayByRail": { "evm": 0.02, "solana": 0 } }

# Without the key
curl -s localhost:4032/ledger
# { "error": "UNAUTHORIZED", "hint": "Send X-Admin-Key header (ADMIN_KEY env)" }
```

Only `kind: "spend"` entries consume budget. Evaluations are logged as `approved-intent` / `denied-intent` and cost nothing.

## 6. Errors you'll actually hit

```bash
# Missing required fields
curl -s -X POST localhost:4032/policy-check -H 'content-type: application/json' -d '{}' \
  -H "X-PAYMENT: $X_PAYMENT" | jq
# { "error": "BAD_REQUEST", "hint": "POST { merchant: string, amountUsd: number, … }" }

# Garbage payment header  → 402 "invalid X-PAYMENT header: …"
# Wrong network signed    → 402 "unsupported rail: …"
# Facilitator down        → 502 { "error": "facilitator_unreachable" }   (not charged)
```
