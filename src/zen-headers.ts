// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared OpenCode Zen request identity: headers, session synthesis, and the
 * `before_provider_headers` hook payload transform.
 *
 * Single source of truth for `src/index.ts`, `src/discovery.ts`, and
 * `scripts/smoke-real.ts`.
 *
 * Mirrors the 2026-10-14 free-tier gate contract (verified via
 * jasonxu114514/opencode2api #81-#84): upstream fingerprints the client on
 * every lane, and each of these alone turns a request into a 403
 * FreeTierError:
 *
 * 1. Endpoint — keyless inference moved off `/zen` onto
 *    `https://opencode.ai/inference` (`/v1/chat/completions`,
 *    `/v1/responses`, `/v1/messages`). The models listing is still served
 *    from the legacy Zen console (`/zen/v1/models`), so discovery keeps its
 *    own URL.
 * 2. Header shape — `opencode/<channel>/<version>/<name>` User-Agent,
 *    `x-opencode-session` AND `x-opencode-session-id` carrying the same
 *    descending-encoded session id, a non-canonical `x-opencode-project`
 *    (the client's own `global` passes), and NO `x-opencode-request`.
 *    Legacy values (`opencode/1.18.31`, canonical `prj_*` project ids) 403.
 * 3. Auth — the anonymous credential is the literal token `public`
 *    (case-sensitive), as `Bearer public` on the OpenAI-compatible lanes and
 *    `x-api-key: public` on the Anthropic lane.
 */
import { randomBytes } from "node:crypto";

/** Keyless inference base (OpenAI-compatible engines; SDK appends the path). */
export const ZEN_BASE_URL = "https://opencode.ai/inference/v1";
/** Anthropic-messages base (bare root; Anthropic SDK appends `/v1/messages`). */
export const ZEN_ANTHROPIC_BASE_URL = "https://opencode.ai/inference";

/** Only base URLs we ever persist or restore; anything else is dropped. */
const TRUSTED_BASE_URLS = new Set([ZEN_BASE_URL, ZEN_ANTHROPIC_BASE_URL]);

/**
 * The free-tier gate fingerprints the OpenCode client. Upstream accepts a
 * range of releases (the version number itself is not validated), kept
 * current with the latest public `@opencode/cli`.
 */
export const OPENCODE_USER_AGENT = "opencode/latest/2.0.29/cli";

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
/** 48-bit word the session id's time part lives in. */
const MASK48 = 0xffffffffffn;
/** Client Identifier counters cycle 1..48; the gate accepts low counters. */
const SESSION_COUNTER_MAX = 48n;

let sessionCounter = 0n;

/**
 * Mirrors the official client's `Identifier.descending()` session layout:
 * the 12 lowercase hex characters are `~(ts_ms << 12 | counter)` truncated to
 * 48 bits. Upstream validates HOW the time part is encoded (an ascending
 * timestamp or a foreign encoding is rejected with 403 even when the `ses_`
 * shape is right), so the timestamp half must be minted this way.
 *
 * The 14 base62 remaining characters are random, as in the client.
 */
export function canonicalSessionId(): string {
  sessionCounter = (sessionCounter % SESSION_COUNTER_MAX) + 1n;
  const current =
    ((BigInt(Date.now()) << 12n) | sessionCounter) & MASK48;
  const inverted = ~current & MASK48;
  const timePart = inverted.toString(16).padStart(12, "0").toLowerCase();
  let value = 0n;
  for (const byte of randomBytes(11)) value = (value << 8n) | BigInt(byte);
  let suffix = "";
  for (let i = 0; i < 14; i++) {
    suffix = BASE62[Number(value % 62n)] + suffix;
    value /= 62n;
  }
  return `ses_${timePart}${suffix}`;
}

/** Same shape as pi-ai `ProviderHeaders`; kept local to avoid subpath imports. */
export type MutableHeaders = Record<string, string | null>;

/**
 * Auth lane of the backend the request goes to. The anonymous credential
 * rides a DIFFERENT header per lane, and an `Authorization` header on the
 * Anthropic/Google lanes is itself an instant 403 — so lane callers (the
 * `zen-*` engine adapters) must state their lane explicitly.
 */
export type ZenAuthLane = "openai" | "anthropic" | "google";

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
 * `before_provider_headers` for every native engine and inside each `zen-*`
 * engine adapter (see `./zen-engines.js`) — the adapter path is what makes
 * foreground (`async:false`) children work, since they inherit providers but
 * no ambient hooks. Either way one transform covers all backends. Gated on
 * the OpenCode identity headers our provider sets; foreign traffic
 * (no `x-opencode-client`/`x-opencode-project`) is left untouched.
 *
 * Mirrors the official client's header set exactly: `x-opencode-session`
 * plus `x-opencode-session-id` (both required since 2026-10-14) carrying the
 * same descending-encoded id, and no `x-opencode-request` (its presence is
 * an instant 403). The anonymous credential `public` rides the auth header
 * each lane expects — `Bearer public` on OpenAI-compatible traffic only:
 * an `Authorization` header on the Anthropic/Google lanes is itself a 403.
 */
export function applyOpenCodeFreeHeaders(
  headers: MutableHeaders,
  lane?: ZenAuthLane,
): void {
  if (getHeader(headers, "x-opencode-client") !== "cli") return;
  if (!getHeader(headers, "x-opencode-project")) return;

  // Identity first: compaction/summarization and normal turns share this path.
  // Pi's attribution may have set `x-opencode-client: pi`; restore `cli`.
  headers["x-opencode-client"] = "cli";
  const session = canonicalSessionId();
  headers["x-opencode-session"] = session;
  headers["x-opencode-session-id"] = session;
  headers["x-session-affinity"] = session;
  headers["X-Session-Id"] = session;
  // The gate rejects the legacy correlation header upstream; drop every case
  // variant so it never reaches the wire.
  deleteHeader(headers, "x-opencode-request");
  deleteHeader(headers, "user-agent");
  headers["User-Agent"] = OPENCODE_USER_AGENT;

  // Auth per lane. OpenAI-compatible engines (completions + responses)
  // require the literal `Bearer public` token on the keyless lane (absent
  // header 401s; the comparison is case-sensitive). The Anthropic lane is
  // keyed by `x-api-key` alone and the Google lane by `x-goog-api-key` — a
  // Bearer credential on those lanes is an instant 403. Lane callers state
  // their lane; ambient (hook) callers fall back to presence detection.
  const effectiveLane: ZenAuthLane =
    lane ??
    (getHeader(headers, "x-api-key") !== undefined
      ? "anthropic"
      : getHeader(headers, "x-goog-api-key") !== undefined
        ? "google"
        : "openai");
  deleteHeader(headers, "authorization");
  if (effectiveLane === "anthropic") {
    deleteHeader(headers, "x-api-key");
    headers["x-api-key"] = "public";
  } else if (effectiveLane === "google") {
    deleteHeader(headers, "x-goog-api-key");
    headers["x-goog-api-key"] = "public";
  } else {
    headers["Authorization"] = "Bearer public";
  }
}
