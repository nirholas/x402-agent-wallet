import "dotenv/config";
import express from "express";
import { readFileSync, existsSync } from "node:fs";
import { activeRails, mountSolanaCheckout, paymentReceipt, paywall, usingSuiteDefaultPayTo } from "./payments.js";
import { PolicyEngine, railOf, type SpendIntent, type WalletPolicy } from "./policy.js";
import { signed, verify } from "./sign.js";

/**
 * x402-agent-wallet daemon.
 *
 *   POST /policy-check   $0.001  → signed verdict {allowed, reason, remainingBudget}
 *   POST /record-spend   free*   → record a settled spend against the budget
 *   GET  /ledger         free*   → spend history        (*requires X-Admin-Key)
 *   GET  /policy         free    → the policy in force + its digest
 *   POST /verify         free    → verify a signed verdict
 *
 * Why is /policy-check itself paid? Two reasons. A wallet daemon that answers
 * unbounded free queries is a denial-of-service target — the price is the rate
 * limit. And when other agents outsource policy decisions to your daemon, the
 * $0.001 covers what it costs you to run. The verdict comes back signed, so the
 * caller can prove to a supervisor what it was told.
 */

const port = Number(process.env.PORT || 4032);
const adminKey = process.env.ADMIN_KEY || "dev-admin-key";

const policyFile = process.env.POLICY_FILE || "config/policy.json";
const policy: WalletPolicy = existsSync(policyFile)
  ? (JSON.parse(readFileSync(policyFile, "utf8")) as WalletPolicy)
  : { dailyBudgetUsd: 1, perRequestMaxUsd: 0.1 };

const engine = new PolicyEngine(policy, { ledgerFile: process.env.LEDGER_FILE || "data/spend-ledger.json" });

const app = express();
app.use(express.json());

const PRICES: Record<string, string> = {
  "POST /policy-check": "$0.001",
};

app.use(paywall(PRICES, { service: "x402-agent-wallet" }));

app.post("/policy-check", (req, res) => {
  const body = (req.body ?? {}) as Partial<SpendIntent>;
  if (!body.merchant || typeof body.amountUsd !== "number") {
    res.status(400).json({
      error: "BAD_REQUEST",
      hint: "POST { merchant: string, amountUsd: number, resource?, network?, rail?, approvalRef? }",
    });
    return;
  }
  const verdict = engine.checkAndLog({
    merchant: body.merchant,
    amountUsd: body.amountUsd,
    resource: body.resource,
    network: body.network,
    rail: body.rail ?? railOf(body.network),
    approvalRef: body.approvalRef,
  });
  // The verdict IS the artifact — signed, so the caller can hand it to a
  // supervisor as proof of what this wallet authorised.
  res.json({ verdict: signed(verdict), paidWith: paymentReceipt(res) });
});

app.post("/record-spend", (req, res) => {
  if (req.header("X-Admin-Key") !== adminKey) {
    res.status(401).json({ error: "UNAUTHORIZED", hint: "Send X-Admin-Key header (ADMIN_KEY env)" });
    return;
  }
  const body = (req.body ?? {}) as { merchant?: string; amountUsd?: number; resource?: string; network?: string; verdictId?: string };
  if (!body.merchant || typeof body.amountUsd !== "number") {
    res.status(400).json({ error: "BAD_REQUEST", hint: "POST { merchant, amountUsd, resource?, network?, verdictId? }" });
    return;
  }
  const entry = engine.recordSpend({
    merchant: body.merchant,
    amountUsd: body.amountUsd,
    resource: body.resource,
    network: body.network,
    verdictId: body.verdictId,
  });
  res.json({ entry, spentTodayUsd: engine.spentTodayUsd() });
});

app.get("/ledger", (req, res) => {
  if (req.header("X-Admin-Key") !== adminKey) {
    res.status(401).json({ error: "UNAUTHORIZED", hint: "Send X-Admin-Key header (ADMIN_KEY env)" });
    return;
  }
  res.json({
    policy: engine.policy,
    policyDigest: engine.policyDigest(),
    spentTodayUsd: engine.spentTodayUsd(),
    spentTodayByRail: {
      evm: engine.spentTodayUsd({ rail: "evm" }),
      solana: engine.spentTodayUsd({ rail: "solana" }),
    },
    entries: engine.ledger(),
  });
});

app.get("/policy", (_req, res) => {
  res.json({ policy: engine.policy, policyDigest: engine.policyDigest(), spentTodayUsd: engine.spentTodayUsd() });
});

app.post("/verify", (req, res) => {
  const { payload, signature } = (req.body ?? {}) as { payload?: unknown; signature?: string };
  if (payload === undefined || !signature) {
    res.status(400).json({ error: "BAD_REQUEST", hint: "POST { payload, signature }" });
    return;
  }
  res.json({ valid: verify(payload, signature) });
});

app.get("/.well-known/x402", (_req, res) => {
  res.type("application/json").send(readFileSync("public/.well-known/x402", "utf8"));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "x402-agent-wallet", rails: activeRails() });
});

app.use(express.static("public"));

await mountSolanaCheckout(app);

app.listen(port, () => {
  console.log(`\nx402-agent-wallet daemon on http://localhost:${port}`);
  console.log("\nPayment rails (client picks one):");
  for (const rail of activeRails()) {
    console.log(`  ${rail.rail.padEnd(7)} ${rail.network.padEnd(14)} USDC → ${rail.payTo}`);
  }
  if (usingSuiteDefaultPayTo()) {
    console.log("  note: using suite default payTo — set PAY_TO_ADDRESS / SOLANA_PAY_TO_ADDRESS to receive funds yourself");
  }
  console.log(`\nPolicy: ${policyFile}`);
  console.log(`  daily budget      $${engine.policy.dailyBudgetUsd}`);
  console.log(`  per-request max   $${engine.policy.perRequestMaxUsd}`);
  console.log(`  approval above    ${engine.policy.approvalThresholdUsd !== undefined ? `$${engine.policy.approvalThresholdUsd}` : "(disabled)"}`);
  console.log(`  allowed rails     ${(engine.policy.allowedRails ?? ["evm", "solana"]).join(", ")}`);
  console.log(`  spent today       $${engine.spentTodayUsd()}`);
  console.log("\nPaid routes:");
  for (const [route, price] of Object.entries(PRICES)) console.log(`  ${route}  ${price}`);
  console.log("\nFree routes:\n  GET /ledger (X-Admin-Key)\n  POST /record-spend (X-Admin-Key)\n  GET /policy\n  POST /verify\n  GET /.well-known/x402\n  GET /health\n");
});
