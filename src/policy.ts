import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sign } from "./sign.js";

/**
 * PolicyEngine — the heart of x402-agent-wallet.
 *
 * A WalletPolicy declares what an agent is allowed to spend; the engine
 * evaluates SpendIntents against it, tracks actual spend in a file-backed
 * ledger, and produces verdicts that can be HMAC-signed and handed around.
 *
 * Budget windows are UTC days. Amounts are USD (x402 USDC prices are
 * dollar-denominated; 1 USDC = $1).
 */

export interface WalletPolicy {
  /** Total spend allowed per UTC day, in USD. */
  dailyBudgetUsd: number;
  /** Hard cap for any single payment, in USD. */
  perRequestMaxUsd: number;
  /**
   * Spends at or above this amount are allowed only with `approvalRef`
   * present on the intent (a human/supervisor sign-off id). Omit to disable.
   */
  approvalThresholdUsd?: number;
  /** Per-merchant daily caps, keyed by merchant host (e.g. "api.example.com"). */
  perMerchantDailyUsd?: Record<string, number>;
  /** If non-empty, only these merchant hosts may be paid. */
  allowedMerchants?: string[];
  /** Merchant hosts that may never be paid. */
  blockedMerchants?: string[];
  /** Payment networks the agent may settle on. Default: any. */
  allowedNetworks?: string[];
  /**
   * Payment rails the agent may use. Default: both. x402 offers USDC on Base
   * (`"evm"`) and USDC on Solana (`"solana"`); a treasury that only funds one
   * chain should say so here rather than discovering it at signing time.
   */
  allowedRails?: ("evm" | "solana")[];
  /** Rail to choose when the merchant offers both. Default: the merchant's order. */
  preferRail?: "evm" | "solana";
  /** Per-rail daily caps in USD, e.g. `{ solana: 0.5 }`. */
  perRailDailyUsd?: Partial<Record<"evm" | "solana", number>>;
}

/** `solana` / `solana-devnet` → `"solana"`; everything else → `"evm"`. */
export function railOf(network: string | undefined): "evm" | "solana" {
  return String(network ?? "").toLowerCase().startsWith("solana") ? "solana" : "evm";
}

export interface SpendIntent {
  /** Merchant host (e.g. "api.example.com"). */
  merchant: string;
  /** Payment amount in USD. */
  amountUsd: number;
  /** Resource URL or route being purchased. */
  resource?: string;
  /** Settlement network (e.g. "base-sepolia" or "solana"). */
  network?: string;
  /** Rail; derived from `network` when omitted. */
  rail?: "evm" | "solana";
  /** Reference to a human/supervisor approval, for above-threshold spends. */
  approvalRef?: string;
}

export interface PolicyVerdict {
  verdictId: string;
  allowed: boolean;
  reason: string;
  /** True when the amount crossed approvalThresholdUsd. */
  requiresApproval: boolean;
  intent: SpendIntent;
  remainingBudget: {
    dailyUsd: number;
    merchantDailyUsd?: number;
    railDailyUsd?: number;
  };
  /** HMAC digest of the policy that produced this verdict. */
  policyDigest: string;
  checkedAt: string;
}

export interface SpendEntry {
  id: string;
  kind: "spend" | "approved-intent" | "denied-intent";
  merchant: string;
  amountUsd: number;
  resource?: string;
  network?: string;
  rail?: "evm" | "solana";
  verdictId?: string;
  reason?: string;
  at: string;
}

export interface PolicyEngineOptions {
  /** Ledger persistence file. Default: data/spend-ledger.json */
  ledgerFile?: string;
  /** Disable persistence (in-memory only). */
  ephemeral?: boolean;
}

export class PolicyEngine {
  readonly policy: WalletPolicy;
  private entries: SpendEntry[] = [];
  private readonly file: string;
  private readonly ephemeral: boolean;

  constructor(policy: WalletPolicy, options: PolicyEngineOptions = {}) {
    validatePolicy(policy);
    this.policy = policy;
    this.file = options.ledgerFile ?? "data/spend-ledger.json";
    this.ephemeral = options.ephemeral ?? false;
    this.load();
  }

  /** Evaluate an intent. Does not record anything by itself. */
  check(intent: SpendIntent): PolicyVerdict {
    const p = this.policy;
    const merchant = normalizeMerchant(intent.merchant);
    const rail = intent.rail ?? railOf(intent.network);
    const spentToday = this.spentTodayUsd();
    const spentMerchant = this.spentTodayUsd({ merchant });
    const spentRail = this.spentTodayUsd({ rail });
    const merchantCap = p.perMerchantDailyUsd?.[merchant];
    const railCap = p.perRailDailyUsd?.[rail];

    const remaining = {
      dailyUsd: round2(Math.max(0, p.dailyBudgetUsd - spentToday)),
      ...(merchantCap !== undefined
        ? { merchantDailyUsd: round2(Math.max(0, merchantCap - spentMerchant)) }
        : {}),
      ...(railCap !== undefined ? { railDailyUsd: round2(Math.max(0, railCap - spentRail)) } : {}),
    };

    const deny = (reason: string, requiresApproval = false): PolicyVerdict =>
      this.verdict(intent, false, reason, requiresApproval, remaining);
    const allow = (reason: string, requiresApproval = false): PolicyVerdict =>
      this.verdict(intent, true, reason, requiresApproval, remaining);

    if (!(intent.amountUsd >= 0)) return deny("invalid amount");
    if (p.blockedMerchants?.some((m) => normalizeMerchant(m) === merchant)) {
      return deny(`merchant ${merchant} is blocked`);
    }
    if (p.allowedMerchants && p.allowedMerchants.length > 0 &&
        !p.allowedMerchants.some((m) => normalizeMerchant(m) === merchant)) {
      return deny(`merchant ${merchant} is not on the allowlist`);
    }
    if (intent.network && p.allowedNetworks && p.allowedNetworks.length > 0 &&
        !p.allowedNetworks.includes(intent.network)) {
      return deny(`network ${intent.network} is not allowed`);
    }
    if (!this.railAllowed(rail)) {
      return deny(`rail ${rail} is not allowed (allowedRails: ${(p.allowedRails ?? []).join(", ")})`);
    }
    if (intent.amountUsd > p.perRequestMaxUsd) {
      return deny(`amount $${intent.amountUsd} exceeds per-request max $${p.perRequestMaxUsd}`);
    }
    if (spentToday + intent.amountUsd > p.dailyBudgetUsd) {
      return deny(`daily budget exhausted ($${round2(spentToday)} of $${p.dailyBudgetUsd} spent)`);
    }
    if (merchantCap !== undefined && spentMerchant + intent.amountUsd > merchantCap) {
      return deny(`merchant daily cap exhausted for ${merchant} ($${round2(spentMerchant)} of $${merchantCap})`);
    }
    if (railCap !== undefined && spentRail + intent.amountUsd > railCap) {
      return deny(`${rail} rail daily cap exhausted ($${round2(spentRail)} of $${railCap})`);
    }
    if (p.approvalThresholdUsd !== undefined && intent.amountUsd >= p.approvalThresholdUsd) {
      if (!intent.approvalRef) {
        return deny(
          `amount $${intent.amountUsd} requires approval (threshold $${p.approvalThresholdUsd}) — supply approvalRef`,
          true,
        );
      }
      return allow(`within policy (approved via ${intent.approvalRef})`, true);
    }
    return allow("within policy");
  }

  /**
   * Evaluate AND record: allowed intents are logged as `approved-intent`,
   * denials as `denied-intent`. Used by the daemon's /policy-check route.
   */
  checkAndLog(intent: SpendIntent): PolicyVerdict {
    const verdict = this.check(intent);
    this.append({
      id: `entry_${randomUUID()}`,
      kind: verdict.allowed ? "approved-intent" : "denied-intent",
      merchant: normalizeMerchant(intent.merchant),
      amountUsd: intent.amountUsd,
      resource: intent.resource,
      network: intent.network,
      rail: intent.rail ?? railOf(intent.network),
      verdictId: verdict.verdictId,
      reason: verdict.reason,
      at: verdict.checkedAt,
    });
    return verdict;
  }

  /** Record an actual settled spend (counts against budgets). */
  recordSpend(input: {
    merchant: string;
    amountUsd: number;
    resource?: string;
    network?: string;
    rail?: "evm" | "solana";
    verdictId?: string;
  }): SpendEntry {
    const entry: SpendEntry = {
      id: `entry_${randomUUID()}`,
      kind: "spend",
      merchant: normalizeMerchant(input.merchant),
      amountUsd: input.amountUsd,
      resource: input.resource,
      network: input.network,
      rail: input.rail ?? railOf(input.network),
      verdictId: input.verdictId,
      at: new Date().toISOString(),
    };
    this.append(entry);
    return entry;
  }

  /** Full ledger, newest first. */
  ledger(): SpendEntry[] {
    return [...this.entries].reverse();
  }

  /**
   * USD settled today (UTC), optionally narrowed to one merchant or rail.
   * Only `spend` entries count — evaluated-but-unspent intents never consume
   * budget, so a denied check costs the agent nothing.
   */
  spentTodayUsd(filter: { merchant?: string; rail?: "evm" | "solana" } = {}): number {
    const today = new Date().toISOString().slice(0, 10);
    return round2(
      this.entries
        .filter((e) => e.kind === "spend" && e.at.slice(0, 10) === today)
        .filter((e) => (filter.merchant ? e.merchant === filter.merchant : true))
        .filter((e) => (filter.rail ? (e.rail ?? railOf(e.network)) === filter.rail : true))
        .reduce((sum, e) => sum + e.amountUsd, 0),
    );
  }

  /** Whether the policy permits paying on a rail at all. */
  railAllowed(rail: "evm" | "solana"): boolean {
    const allowed = this.policy.allowedRails;
    return !allowed || allowed.length === 0 || allowed.includes(rail);
  }

  policyDigest(): string {
    return sign(this.policy);
  }

  private verdict(
    intent: SpendIntent,
    allowed: boolean,
    reason: string,
    requiresApproval: boolean,
    remainingBudget: PolicyVerdict["remainingBudget"],
  ): PolicyVerdict {
    return {
      verdictId: `verdict_${randomUUID()}`,
      allowed,
      reason,
      requiresApproval,
      intent,
      remainingBudget,
      policyDigest: this.policyDigest(),
      checkedAt: new Date().toISOString(),
    };
  }

  private append(entry: SpendEntry): void {
    this.entries.push(entry);
    this.save();
  }

  private load(): void {
    if (this.ephemeral || !existsSync(this.file)) return;
    try {
      this.entries = JSON.parse(readFileSync(this.file, "utf8")) as SpendEntry[];
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    if (this.ephemeral) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2));
    renameSync(tmp, this.file);
  }
}

export function validatePolicy(policy: WalletPolicy): void {
  if (typeof policy.dailyBudgetUsd !== "number" || policy.dailyBudgetUsd < 0) {
    throw new Error("policy.dailyBudgetUsd must be a non-negative number");
  }
  if (typeof policy.perRequestMaxUsd !== "number" || policy.perRequestMaxUsd < 0) {
    throw new Error("policy.perRequestMaxUsd must be a non-negative number");
  }
}

export function normalizeMerchant(merchant: string): string {
  try {
    if (merchant.includes("://")) return new URL(merchant).host.toLowerCase();
  } catch {
    // fall through
  }
  return merchant.toLowerCase();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
