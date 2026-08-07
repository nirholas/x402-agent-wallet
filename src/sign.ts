import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 signing over canonical JSON. Policy verdicts issued by the
 * daemon are signed so a supervising process (or the human principal) can
 * verify the wallet daemon actually approved a spend.
 */

const DEV_SECRET = "x402-agent-wallet-dev-secret-change-me";

export function signingSecret(): string {
  return process.env.SIGNING_SECRET || DEV_SECRET;
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export function sign(payload: unknown, secret = signingSecret()): string {
  return createHmac("sha256", secret).update(canonicalize(payload)).digest("hex");
}

export function verify(payload: unknown, signature: string, secret = signingSecret()): boolean {
  const expected = sign(payload, secret);
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

export function signed<T>(payload: T, secret = signingSecret()): SignedRecord<T> {
  return { payload, signature: sign(payload, secret), algorithm: "HMAC-SHA256" };
}

export interface SignedRecord<T> {
  payload: T;
  signature: string;
  algorithm: "HMAC-SHA256";
}
