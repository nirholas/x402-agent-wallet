# Expose x402-agent-wallet as an MCP tool

Two shapes here, and the difference matters.

**Shape A — the wallet as a tool.** The model asks "may I spend this?" and gets a signed verdict it can explain to the user. Good when a human is in the loop.

**Shape B — the wallet as a wrapper.** The policy is enforced inside *every other* paying tool, and the model never gets a say. Good when nobody is watching. Use both.

---

## Install

```bash
npm install @modelcontextprotocol/sdk x402-agent-wallet x402-fetch viem zod
```

## Shape A: ask before buying

`mcp-agent-wallet.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const BASE_URL = process.env.WALLET_URL ?? "http://localhost:4032";
const ADMIN_KEY = process.env.ADMIN_KEY ?? "dev-admin-key";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const pay = wrapFetchWithPayment(fetch, account, 10_000n);   // ≤ $0.01 per call

const server = new McpServer({ name: "x402-agent-wallet", version: "0.1.0" });

server.tool(
  "check_spend",
  "Ask the wallet whether a payment is permitted, BEFORE making it ($0.001 USDC). " +
    "Returns a signed verdict. `allowed: false` is a normal, successful answer — not an error. " +
    "If `requiresApproval` is true, ask the user for a sign-off reference and call again with approvalRef.",
  {
    merchant: z.string().describe("Merchant host or URL, e.g. api.example.com"),
    amountUsd: z.number().positive().describe("Proposed spend in USD"),
    resource: z.string().optional().describe("The resource URL being purchased"),
    network: z.string().optional().describe("base-sepolia | base | solana | solana-devnet"),
    approvalRef: z.string().optional().describe("Human sign-off id for above-threshold spends"),
  },
  async (intent) => {
    const res = await pay(`${BASE_URL}/policy-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(intent),
    });
    const body = await res.json();
    const receiptHeader = res.headers.get("x-payment-response");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { ...body, paymentReceipt: receiptHeader ? decodeXPaymentResponse(receiptHeader) : null },
            null,
            2,
          ),
        },
      ],
      isError: !res.ok,          // a denial is res.ok — never an error
    };
  },
);

server.tool(
  "get_policy",
  "Read the wallet's spending rules and today's total. Free — call this before planning a run.",
  {},
  async () => {
    const res = await fetch(`${BASE_URL}/policy`);
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

server.tool(
  "get_ledger",
  "Full spend history with per-rail totals. Requires the admin key.",
  {},
  async () => {
    const res = await fetch(`${BASE_URL}/ledger`, { headers: { "X-Admin-Key": ADMIN_KEY } });
    return { content: [{ type: "text", text: await res.text() }], isError: !res.ok };
  },
);

await server.connect(new StdioServerTransport());
```

## Shape B: enforce it under every paying tool

The model can't route around this one — no tool call, no decision, no prompt to inject:

```ts
import { wrapPayerFetch, PolicyViolationError, NoUsableRailError } from "x402-agent-wallet";
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
  },
});

// Every paid tool in the server uses payFetch instead of fetch.
server.tool("buy_data", "…", { url: z.string() }, async ({ url }) => {
  try {
    const res = await payFetch(url);
    return { content: [{ type: "text", text: await res.text() }] };
  } catch (err) {
    if (err instanceof PolicyViolationError) {
      // Tell the model *why*, with numbers — it can then choose a cheaper path.
      return {
        content: [{ type: "text", text: `Blocked by wallet policy: ${err.verdict.reason}. ` +
          `Remaining today: $${err.verdict.remainingBudget.dailyUsd}.` }],
        isError: true,
      };
    }
    if (err instanceof NoUsableRailError) {
      return {
        content: [{ type: "text", text: `Merchant only accepts ${err.offered.join(", ")}, ` +
          `which this wallet cannot pay on.` }],
        isError: true,
      };
    }
    throw err;
  }
});
```

## Claude Desktop config

```json
{
  "mcpServers": {
    "x402-agent-wallet": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-agent-wallet.ts"],
      "env": {
        "PRIVATE_KEY": "0xYourAgentWalletKey",
        "WALLET_URL": "http://localhost:4032",
        "ADMIN_KEY": "your-admin-key"
      }
    }
  }
}
```

## Notes that matter in practice

- **A denial is not an error.** Key `isError` off the HTTP status, never off `allowed`. Otherwise the model retries a question it already got a valid answer to.
- **Give the model the numbers.** `remainingBudget` in a refusal lets it pick a cheaper endpoint instead of guessing.
- **`requiresApproval` is a workflow, not a wall.** Surface it to the user, collect an `approvalRef`, retry. An approval nobody can grant is just a lower cap.
- **Don't expose `get_ledger` to untrusted contexts.** It reveals every merchant the agent has paid.
- **Shape B beats Shape A for safety.** A tool the model chooses to call is a tool it can be talked out of calling.
