/**
 * x402-agent-wallet — spending policy for AI agents that pay with x402.
 * Budgets, per-merchant caps, per-rail caps, approval thresholds, and signed
 * verdicts. Works across both x402 rails: USDC on Base and USDC on Solana.
 *
 * Two ways to use it.
 *
 * **1. Client-side (recommended).** Wrap your paying fetch so a disallowed
 * payment is never signed — no refund to chase, nothing on-chain:
 *
 * ```ts
 * import { wrapPayerFetch } from "x402-agent-wallet";
 * import { createSigner } from "x402-fetch";
 *
 * const payFetch = wrapPayerFetch(fetch, {
 *   signer: {
 *     evm: await createSigner("base-sepolia", process.env.EVM_KEY!),
 *     svm: await createSigner("solana", process.env.SOLANA_KEY!),
 *   },
 *   policy: {
 *     dailyBudgetUsd: 1,
 *     perRequestMaxUsd: 0.05,
 *     perMerchantDailyUsd: { "api.example.com": 0.25 },
 *     perRailDailyUsd: { solana: 0.5 },
 *     approvalThresholdUsd: 0.02,
 *   },
 *   onVerdict: (v) => console.log(v.allowed ? "allow" : `deny: ${v.reason}`),
 * });
 *
 * await payFetch("https://api.example.com/paid");   // enforced before signing
 * ```
 *
 * **2. As a daemon.** Run the server and have agents (or a supervisor) call
 * `POST /policy-check` for signed verdicts against a shared ledger — useful
 * when several agents draw on one budget.
 */

export {
  PolicyEngine,
  validatePolicy,
  normalizeMerchant,
  railOf,
  type WalletPolicy,
  type SpendIntent,
  type PolicyVerdict,
  type SpendEntry,
  type PolicyEngineOptions,
} from "./policy.js";

export {
  wrapPayerFetch,
  PolicyViolationError,
  NoUsableRailError,
  type WrapPayerFetchOptions,
} from "./wrap.js";

export {
  paywall,
  paymentReceipt,
  activeRails,
  routeMatches,
  usingSuiteDefaultPayTo,
  mountSolanaCheckout,
  DEFAULT_EVM_PAY_TO,
  DEFAULT_SOLANA_PAY_TO,
  type PaymentReceipt,
  type PaywallOptions,
  type RailInfo,
  type RoutePrices,
} from "./payments.js";

export { sign, verify, signed, canonicalize, type SignedRecord } from "./sign.js";
