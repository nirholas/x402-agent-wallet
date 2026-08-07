import { wrapFetchWithPayment, type Signer, type MultiNetworkSigner } from "x402-fetch";
import type { PaymentRequirements } from "x402/types";
import { PolicyEngine, railOf, type PolicyVerdict, type WalletPolicy } from "./policy.js";

/**
 * wrapPayerFetch — client-side enforcement of a WalletPolicy on any x402-paying
 * fetch. This is the half of the wallet that matters: the policy check happens
 * *inside* the payment-requirements selection step, so a disallowed payment is
 * never signed. No refund to chase, no on-chain footprint, no trust in a remote
 * daemon.
 *
 *   fetch → 402 → choose rail → POLICY CHECK → sign & retry → 200
 *                                    │
 *                                    └── PolicyViolationError (nothing was signed)
 *
 * The 402 offers both rails; the wrapper picks one your signer can actually use,
 * subject to `policy.allowedRails`, then evaluates the spend. Settled spends are
 * recorded in the engine's ledger (the `X-PAYMENT-RESPONSE` header on the 200
 * confirms settlement), so budgets track reality rather than intent.
 */

export class PolicyViolationError extends Error {
  constructor(public readonly verdict: PolicyVerdict) {
    super(`Payment blocked by wallet policy: ${verdict.reason}`);
    this.name = "PolicyViolationError";
  }
}

/** Raised when the merchant offers no rail this wallet can pay on. */
export class NoUsableRailError extends Error {
  constructor(public readonly offered: string[]) {
    super(`Merchant offered no rail this wallet can pay on. Offered: ${offered.join(", ") || "nothing"}`);
    this.name = "NoUsableRailError";
  }
}

export interface WrapPayerFetchOptions {
  /**
   * Wallet that signs x402 payments. Pass a single signer, or
   * `{ evm, svm }` to pay on whichever rail the merchant prefers.
   */
  signer: Signer | MultiNetworkSigner;
  /** Policy to enforce, or a pre-built PolicyEngine (shares its ledger). */
  policy: WalletPolicy | PolicyEngine;
  /** Called with every verdict — allowed or not. Useful for audit logs. */
  onVerdict?: (verdict: PolicyVerdict) => void;
  /**
   * Rails this signer can actually sign for. Defaults to both when a
   * MultiNetworkSigner is supplied, otherwise inferred at selection time.
   */
  rails?: ("evm" | "solana")[];
}

export function wrapPayerFetch(
  baseFetch: typeof globalThis.fetch,
  options: WrapPayerFetchOptions,
): (input: RequestInfo, init?: RequestInit) => Promise<Response> {
  const engine =
    options.policy instanceof PolicyEngine
      ? options.policy
      : new PolicyEngine(options.policy, { ephemeral: true });

  const signerRails =
    options.rails ??
    (isMultiNetwork(options.signer) ? (["evm", "solana"] as const).slice() : undefined);

  return async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
    let approved: { verdict: PolicyVerdict; requirement: PaymentRequirements } | undefined;

    const select = (accepts: PaymentRequirements[]): PaymentRequirements => {
      const merchant = merchantOf(accepts[0]?.resource, input);

      // Narrow to rails this wallet can sign for and the policy permits, in the
      // policy's stated preference order.
      const usable = accepts.filter((requirement) => {
        const rail = railOf(requirement.network);
        if (signerRails && !signerRails.includes(rail)) return false;
        return engine.railAllowed(rail);
      });
      if (usable.length === 0) throw new NoUsableRailError(accepts.map((a) => a.network));

      const requirement = preferred(usable, engine.policy.preferRail);
      const amountUsd = Number(requirement.maxAmountRequired) / 1e6;

      const verdict = engine.check({
        merchant,
        amountUsd,
        resource: requirement.resource,
        network: requirement.network,
        rail: railOf(requirement.network),
      });
      options.onVerdict?.(verdict);
      if (!verdict.allowed) throw new PolicyViolationError(verdict);

      approved = { verdict, requirement };
      return requirement;
    };

    // Belt and braces: cap what x402-fetch may ever sign at the policy's
    // per-request max, so a bug in `select` still can't overspend.
    const maxValueAtomic = BigInt(Math.round(engine.policy.perRequestMaxUsd * 1e6));
    const payingFetch = wrapFetchWithPayment(baseFetch, options.signer, maxValueAtomic, select);

    const response = await payingFetch(input, init);

    if (approved && response.ok && response.headers.get("x-payment-response")) {
      engine.recordSpend({
        merchant: merchantOf(approved.requirement.resource, input),
        amountUsd: Number(approved.requirement.maxAmountRequired) / 1e6,
        resource: approved.requirement.resource,
        network: approved.requirement.network,
        rail: railOf(approved.requirement.network),
        verdictId: approved.verdict.verdictId,
      });
    }
    return response;
  };
}

/** Order by the policy's rail preference; otherwise keep the merchant's order. */
function preferred(accepts: PaymentRequirements[], prefer?: "evm" | "solana"): PaymentRequirements {
  if (!prefer) return accepts[0];
  return accepts.find((a) => railOf(a.network) === prefer) ?? accepts[0];
}

function isMultiNetwork(signer: Signer | MultiNetworkSigner): signer is MultiNetworkSigner {
  return typeof signer === "object" && signer !== null && "evm" in signer && "svm" in signer;
}

function merchantOf(resource: string | undefined, input: RequestInfo): string {
  try {
    if (resource) return new URL(resource).host;
  } catch {
    // fall through to the request URL
  }
  try {
    return new URL(typeof input === "string" ? input : input.url).host;
  } catch {
    return "unknown";
  }
}
