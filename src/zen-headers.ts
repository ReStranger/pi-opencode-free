// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared OpenCode Zen request identity: headers, session/request synthesis,
 * and the `before_provider_headers` hook payload transform.
 *
 * Single source of truth for `src/index.ts`, `src/discovery.ts`, and
 * `scripts/smoke-real.ts` — previously each carried its own copy and the
 * `User-Agent` drifted (`0.0.0-dev` vs the pinned client release).
 */
import { randomBytes, randomUUID } from "node:crypto";

/** Zen base URLs: Anthropic Messages lives at the bare gateway root. */
export const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const ZEN_ANTHROPIC_BASE_URL = "https://opencode.ai/zen";

/** Only base URLs we ever persist or restore; anything else is dropped. */
const TRUSTED_BASE_URLS = new Set([ZEN_BASE_URL, ZEN_ANTHROPIC_BASE_URL]);

/**
 * Zen's free-tier gate expects the identity headers of the official OpenCode
 * client. The version only needs to identify an OpenCode client; keep it
 * current with the public client release used by the gateway.
 */
export const OPENCODE_USER_AGENT = "opencode/1.18.31";

/** Native Pi engines this extension routes models to. */
export const KNOWN_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

/** Returns true for a base URL we persist; drops poisoned snapshots. */
export function isTrustedBaseUrl(value: unknown): value is string {
  return typeof value === "string" && TRUSTED_BASE_URLS.has(value);
}

/** Returns true for a native engine id; drops poisoned `api` values. */
export function isKnownApi(value: unknown): value is string {
  return typeof value === "string" && KNOWN_APIS.has(value);
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Current Zen validates the canonical OpenCode session shape, not merely the
 * `ses_` prefix: 12 lowercase hex timestamp characters plus 14 base62 chars.
 */
export function canonicalSessionId(): string {
  const timestamp = Date.now().toString(16).padStart(12, "0").slice(-12);
  let value = 0n;
  for (const byte of randomBytes(11)) value = (value << 8n) | BigInt(byte);
  let suffix = "";
  for (let i = 0; i < 14; i++) {
    suffix = BASE62[Number(value % 62n)] + suffix;
    value /= 62n;
  }
  return `ses_${timestamp}${suffix}`;
}

/** Same shape as pi-ai `ProviderHeaders`; kept local to avoid subpath imports. */
export type MutableHeaders = Record<string, string | null>;

export function getHeader(
  headers: MutableHeaders,
  name: string,
): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

/** Deletes every case variant of a header (`Authorization` vs `authorization`). */
export function deleteHeader(headers: MutableHeaders, name: string): void {
  const expected = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === expected) delete headers[key];
  }
}

/**
 * Zen request transform for our provider's traffic. Runs inside Pi's
 * `before_provider_headers` for every native engine (and inside the
 * provider-level `streamSimple` wrapper for the completions engine, which is
 * what makes foreground children work), so one place covers all backends.
 * Gated on the OpenCode identity headers our provider sets; foreign traffic
 * (no `x-opencode-client`/`x-opencode-project`) is left untouched.
 *
 * Always stamps the official OpenCode client identity (`x-opencode-session`,
 * `x-opencode-request`, `User-Agent`). Pure keyless: every auth header on
 * our traffic is nulled (`null` is Pi's documented "delete this header"
 * value), so neither the `"none"` placeholder nor any stored credential
 * ever leaks on the wire.
 */
export function applyOpenCodeFreeHeaders(headers: MutableHeaders): void {
  if (getHeader(headers, "x-opencode-client") !== "cli") return;
  if (!getHeader(headers, "x-opencode-project")) return;

  // Identity first: compaction/summarization and normal turns share this path,
  // and retries reuse headers — every request needs fresh canonical ids.
  // Pi's attribution may have set `x-opencode-client: pi`; restore `cli`.
  headers["x-opencode-client"] = "cli";
  headers["x-opencode-session"] = canonicalSessionId();
  headers["x-opencode-request"] = `msg_${randomUUID()}`;
  deleteHeader(headers, "user-agent");
  headers["User-Agent"] = OPENCODE_USER_AGENT;

  // OpenAI-compatible engines (completions + responses): Bearer auth.
  // Always null (even when absent) so the SDK's `apiKey: "none"` param is
  // overridden instead of leaking as `Bearer none`. Delete first so a
  // lowercase variant (fetch/Undici normalization) cannot survive alongside.
  deleteHeader(headers, "authorization");
  headers["Authorization"] = null;

  // Anthropic (`x-api-key`) and Google (`x-goog-api-key`) native auth paths.
  // Only touch when present — never add a null when absent.
  if (getHeader(headers, "x-api-key") !== undefined) {
    deleteHeader(headers, "x-api-key");
    headers["x-api-key"] = null;
  }

  if (getHeader(headers, "x-goog-api-key") !== undefined) {
    deleteHeader(headers, "x-goog-api-key");
    headers["x-goog-api-key"] = null;
  }
}
