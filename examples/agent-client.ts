/**
 * Two things at once:
 *   1. Paying the daemon's $0.001 /policy-check route with x402 (the full
 *      402 → sign → 200 flow), and
 *   2. Using wrapPayerFetch locally, which is the cheaper and safer way to
 *      enforce the same policy — the check happens before anything is signed.
 *
 *   PRIVATE_KEY=0x… npx tsx examples/agent-client.ts
 *
 * Without PRIVATE_KEY the script still runs part 1 up to the 402 and all of
 * part 2 (local enforcement needs no chain at all).
 */
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { wrapPayerFetch, PolicyViolationError, PolicyEngine } from "../src/index.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4032";
const intent = { merchant: "api.example.com", amountUsd: 0.02, network: "base-sepolia" };

// ── Part 1: pay the daemon for a signed verdict ─────────────────────────────

const challenge = await fetch(`${BASE_URL}/policy-check`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(intent),
});

if (challenge.status !== 402) {
  console.error(`Expected 402, got ${challenge.status}. Is the daemon running?`);
  process.exit(1);
}

const { accepts } = (await challenge.json()) as {
  accepts: { network: string; maxAmountRequired: string; payTo: string }[];
};

console.log("402 Payment Required — the daemon accepts:");
for (const accept of accepts) {
  console.log(
    `  ${accept.network.padEnd(14)} $${(Number(accept.maxAmountRequired) / 1e6).toFixed(4)} USDC → ${accept.payTo}`,
  );
}

if (process.env.PRIVATE_KEY) {
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const pay = wrapFetchWithPayment(fetch, account);

  const paid = await pay(`${BASE_URL}/policy-check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(intent),
  });

  const body = (await paid.json()) as { verdict: { payload: Record<string, unknown>; signature: string } };
  const receiptHeader = paid.headers.get("x-payment-response");

  console.log(`\n${paid.status} ${paid.statusText}`);
  if (receiptHeader) console.log("X-PAYMENT-RESPONSE:", decodeXPaymentResponse(receiptHeader));
  console.log("\nSigned verdict:");
  console.log(JSON.stringify(body.verdict, null, 2));

  // The verdict is signed — hand it to a supervisor as proof of authorisation.
  const check = await fetch(`${BASE_URL}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body.verdict),
  });
  console.log("Signature valid:", ((await check.json()) as { valid: boolean }).valid);
} else {
  console.log("\nSet PRIVATE_KEY (a funded base-sepolia wallet) to pay and see the signed verdict.");
}

// ── Part 2: local enforcement, no daemon, no chain ──────────────────────────
//
// This is how you should actually run a budget. wrapPayerFetch evaluates the
// policy inside x402-fetch's requirement-selection step, so a disallowed
// payment is never signed: nothing settles, nothing needs refunding.

console.log("\n── local policy enforcement ──");

// Note what the policy is evaluated against: the price in the merchant's 402
// (`maxAmountRequired`), not whatever amount you had in mind. That is the only
// number that can actually be signed. Here the daemon asks $0.001, so a
// per-request ceiling below that blocks it.
const engine = new PolicyEngine(
  {
    dailyBudgetUsd: 0.1,
    perRequestMaxUsd: 0.0005,        // deliberately below the daemon's $0.001
    perRailDailyUsd: { solana: 0.05 },
    blockedMerchants: ["evil.example"],
    allowedRails: ["evm", "solana"],
    preferRail: "evm",
  },
  { ephemeral: true },
);

const guardedFetch = wrapPayerFetch(fetch, {
  // No real signer needed here: the policy rejects before signing is reached.
  signer: {} as never,
  policy: engine,
  onVerdict: (v) => console.log(`  verdict: ${v.allowed ? "allow" : "deny"} — ${v.reason}`),
});

try {
  await guardedFetch(`${BASE_URL}/policy-check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(intent),
  });
} catch (err) {
  if (err instanceof PolicyViolationError) {
    console.log("  blocked before signing:", err.verdict.reason);
    console.log("  remaining budget:", err.verdict.remainingBudget);
  } else {
    throw err;
  }
}

// ── Paying on Solana instead ────────────────────────────────────────────────
//
// The same 402 also offers `network: "solana"`. Give wrapPayerFetch a
// multi-network signer and it will pick whichever rail your policy prefers:
//
//   import { createSigner } from "x402-fetch";
//   const payFetch = wrapPayerFetch(fetch, {
//     signer: {
//       evm: await createSigner("base-sepolia", process.env.EVM_KEY!),
//       svm: await createSigner("solana", process.env.SOLANA_KEY!),   // base58 secret key
//     },
//     policy: { dailyBudgetUsd: 1, perRequestMaxUsd: 0.05, preferRail: "solana" },
//   });
//
// `allowedRails: ["evm"]` in the policy makes the Solana entry unselectable
// even when the merchant offers it, and a merchant offering *only* Solana then
// raises NoUsableRailError instead of quietly paying on a chain you didn't fund.
