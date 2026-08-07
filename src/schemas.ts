// GENERATED from openapi.json — do not edit by hand.
//
// Per-route invocation contracts published inside the x402 402 challenge as
// `accepts[].outputSchema`. `input` tells an agent how to build the request
// (method, query/path params, JSON body fields); `output` is the JSON Schema of
// the 200 body it gets back once payment settles.
//
// Deriving these from `openapi.json` keeps the runtime challenge — which the
// x402scan discovery spec treats as authoritative — from ever contradicting the
// published spec. Regenerate whenever a paid route's parameters or response
// schema change.
//
// Keys match the paywall route map in `server.ts` exactly (`"<METHOD> <path>"`,
// with `:param` for path segments).

import type { RouteSchema } from "./payments.js";

export const ROUTE_SCHEMAS: Record<string, RouteSchema> = {
  "POST /policy-check": {
    "input": {
      "type": "http",
      "method": "POST",
      "bodyType": "json",
      "bodyFields": {
        "merchant": {
          "type": "string",
          "description": "Merchant host or full URL",
          "x-required": true
        },
        "amountUsd": {
          "type": "number",
          "minimum": 0,
          "x-required": true
        },
        "resource": {
          "type": "string"
        },
        "network": {
          "type": "string"
        },
        "rail": {
          "type": "string",
          "enum": [
            "evm",
            "solana"
          ]
        },
        "approvalRef": {
          "type": "string"
        }
      }
    },
    "output": {
      "type": "object",
      "required": [
        "verdict"
      ],
      "properties": {
        "verdict": {
          "type": "object",
          "properties": {
            "payload": {
              "type": "object",
              "properties": {
                "verdictId": {
                  "type": "string"
                },
                "allowed": {
                  "type": "boolean"
                },
                "reason": {
                  "type": "string"
                },
                "requiresApproval": {
                  "type": "boolean"
                },
                "intent": {
                  "type": "object",
                  "required": [
                    "merchant",
                    "amountUsd"
                  ],
                  "properties": {
                    "merchant": {
                      "type": "string",
                      "description": "Merchant host or full URL"
                    },
                    "amountUsd": {
                      "type": "number",
                      "minimum": 0
                    },
                    "resource": {
                      "type": "string"
                    },
                    "network": {
                      "type": "string"
                    },
                    "rail": {
                      "type": "string",
                      "enum": [
                        "evm",
                        "solana"
                      ]
                    },
                    "approvalRef": {
                      "type": "string"
                    }
                  }
                },
                "remainingBudget": {
                  "type": "object",
                  "properties": {
                    "dailyUsd": {
                      "type": "number"
                    },
                    "merchantDailyUsd": {
                      "type": "number"
                    },
                    "railDailyUsd": {
                      "type": "number"
                    }
                  }
                },
                "policyDigest": {
                  "type": "string"
                },
                "checkedAt": {
                  "type": "string",
                  "format": "date-time"
                }
              }
            },
            "signature": {
              "type": "string"
            },
            "algorithm": {
              "type": "string",
              "const": "HMAC-SHA256"
            }
          }
        },
        "paidWith": {
          "type": "object",
          "properties": {
            "success": {
              "type": "boolean"
            },
            "rail": {
              "type": "string",
              "enum": [
                "evm",
                "solana"
              ]
            },
            "network": {
              "type": "string"
            },
            "transaction": {
              "type": "string"
            },
            "payer": {
              "type": "string"
            },
            "amount": {
              "type": "string"
            },
            "asset": {
              "type": "string"
            },
            "resource": {
              "type": "string"
            }
          }
        }
      }
    }
  },
};
