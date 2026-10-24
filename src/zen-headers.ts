// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared OpenCode Zen request identity: headers, session synthesis, and the
 * `before_provider_headers` hook payload transform.
 *
 * Single source of truth for `src/index.ts`, `src/discovery.ts`, and
 * `scripts/smoke-real.ts`.
 *
 * Mirrors the free-tier gate contract (initial 2026-10-14, tools
 * fingerprint synced 2026-10-19, v2 client shape synced 2026-10-20 via
 * jasonxu114514/opencode2api #126): upstream fingerprints the client on
 * every lane, and each of these alone turns a request into a 403
 * FreeTierError:
 *
 * 1. Endpoint — keyless inference moved off `/zen` onto
 *    `https://opencode.ai/inference` (`/v1/chat/completions`,
 *    `/v1/responses`, `/v1/messages`). The models listing is still served
 *    from the legacy Zen console (`/zen/v1/models`), so discovery keeps its
 *    own URL. Anthropic messages requests additionally ride `?beta=true`
 *    (set by the `zen-*` engine adapter, see `./zen-engines.js`).
 * 2. Header shape — the runtime fetch default for `Accept` (all media
 *    types; the 2.1 client sets none explicitly), `opencode/latest/2.1.1/cli`
 *    User-Agent, a non-canonical
 *    `x-opencode-project` (the client's own `global` passes), the session
 *    identity under `x-opencode-session` + `x-opencode-session-id` (one
 *    stable per-process id — the genuine client reuses its session for the
 *    life of its process; an id minted fresh per request reads as a new
 *    handshake every time), and NO `x-opencode-request`. On the Anthropic
 *    lane the v2 client pins a fixed beta set (`anthropic-beta:
 *    interleaved-thinking-2025-05-14`) and `anthropic-version:
 *    2023-06-01`. Legacy values (`opencode/1.18.31`, canonical `prj_*`
 *    project ids) 403.
 * 3. Auth — the anonymous credential is the literal token `public`
 *    (case-sensitive), as `Bearer public` on the OpenAI-compatible lanes and
 *    `x-api-key: public` on the Anthropic lane.
 * 4. Payload — `body.tools` is fingerprinted byte-for-byte against the
 *    Linux CLI release: the `shell` description must carry the Linux
 *    `bash` wording, not the Windows `powershell` wording (403 on
 *    mismatch since 2026-10-19).
 */
import { randomBytes } from "node:crypto";

/**
 * Keyless inference base for the OpenAI-compatible engines (the SDK appends
 * `/chat/completions` or `/responses`). The OpenCode 2.1 client groups the
 * `/inference` routes by provider family, so chat and responses requests go
 * through the `openai` segment (upstream `v2EndpointPath`, #141).
 */
export const ZEN_BASE_URL = "https://opencode.ai/inference/openai/v1";
/**
 * Anthropic-messages base (the Anthropic SDK appends `/v1/messages`). The
 * 2.1 family grouping puts messages under `anthropic` (#141).
 */
export const ZEN_ANTHROPIC_BASE_URL =
  "https://opencode.ai/inference/anthropic";
/**
 * Gemini base. The free catalog currently routes no model through the Google
 * engine, and the upstream gateway captures no family grouping for it, so
 * this stays on the flat legacy inference path.
 */
export const ZEN_GOOGLE_BASE_URL = "https://opencode.ai/inference/v1";

/**
 * Base URLs earlier releases of this extension persisted. Restoring them is
 * allowed only so a snapshot written before the 2.1 route grouping migrates
 * to the current bases instead of being dropped.
 */
const LEGACY_ZEN_BASE_URLS = new Set([
  "https://opencode.ai/inference/v1", // pre-2.1 OpenAI + Google base
  "https://opencode.ai/inference", // pre-2.1 Anthropic base
]);

/** Only base URLs we ever persist or restore; anything else is dropped. */
const TRUSTED_BASE_URLS = new Set([
  ZEN_BASE_URL,
  ZEN_ANTHROPIC_BASE_URL,
  ZEN_GOOGLE_BASE_URL,
  ...LEGACY_ZEN_BASE_URLS,
]);

/**
 * The free-tier gate fingerprints the OpenCode client. Upstream accepts a
 * range of releases (the version number itself is not validated), kept
 * current with the latest public `@opencode/cli` (2.1.1 captured 2026-10-23).
 */
export const OPENCODE_USER_AGENT = "opencode/latest/2.1.1/cli";

/**
 * The fixed beta set the v2 free-tier client sends on Anthropic messages
 * requests. The genuine client derives per-request betas elsewhere, but the
 * gate only recognises this single flag on the keyless lane — a wider set
 * (e.g. fine-grained tool streaming) is rejected, so it overrides whatever
 * the engine would otherwise advertise.
 */
export const ANTHROPIC_BETA = "interleaved-thinking-2025-05-14";
/** Anthropic API version the v2 lane pins alongside the beta set. */
export const ANTHROPIC_VERSION = "2023-06-01";

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
const MASK48 = 0xffffffffffffn;

let lastTimestamp = 0;
let sessionCounter = 0;

/**
 * Mirrors the official client's `Identifier.descending()` session layout:
 * the 12 lowercase hex characters are `~(ts_ms * 0x1000 + counter)` truncated
 * to 48 bits. Upstream validates HOW the time part is encoded (an ascending
 * timestamp or a foreign encoding is rejected with 403 even when the `ses_`
 * shape is right), so the timestamp half must be minted this way.
 *
 * The counter resets whenever the millisecond changes and increments per id,
 * exactly like the client. The 14 base62 remaining characters are random.
 */
export function canonicalSessionId(timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    sessionCounter = 0;
  }
  sessionCounter++;
  const current = BigInt(timestamp) * 0x1000n + BigInt(sessionCounter);
  const timePart = (~current & MASK48)
    .toString(16)
    .padStart(12, "0")
    .toLowerCase();
  const suffix = Array.from(
    randomBytes(14),
    (byte) => BASE62[byte % 62],
  ).join("");
  return `ses_${timePart}${suffix}`;
}

let rootSession: string | undefined;

/**
 * The process-scoped session identity: minted once and reused for the life
 * of the process, like the genuine OpenCode client, which fixes its session
 * id for a whole conversation. A fresh id on every request would read as a
 * new handshake each time (the v2 sync treats per-request ids as a foreign
 * client signal); per-request minting was the pre-sync behavior.
 */
export function zenRootSession(): string {
  rootSession ??= canonicalSessionId();
  return rootSession;
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
 * Mirrors the official client's header set exactly: `Accept` set to the
 * streaming-capable value, `x-opencode-session` plus
 * `x-opencode-session-id` (both required since 2026-10-14) carrying the
 * same descending-encoded per-process id, and no `x-opencode-request`
 * (its presence is an instant 403). The anonymous credential `public` rides the auth header
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
  // The 2.1 client does not set Accept itself: fetch fills `*/*`. The SDKs
  // (OpenAI/Anthropic) default to `application/json`, so pin the value fetch
  // would add rather than leaving the SDK's default on the wire (#143).
  deleteHeader(headers, "accept");
  headers["Accept"] = "*/*";
  // One stable session identity for the whole process (see zenRootSession).
  // Upstream renders the v2 client as: root (parent when present, else own)
  // under `x-opencode-session`, `x-session-affinity` and `X-Session-Id`, and
  // the request's own child id under `x-opencode-session-id`. This host
  // client knows no parent sessions (Pi sessions don't travel in headers),
  // and has one conversation per process — so the child id falls back to
  // the root and all four ids coincide, exactly the childless-client shape
  // the upstream gateway renders.
  const session = zenRootSession();
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
  let effectiveLane: ZenAuthLane;
  if (lane) {
    effectiveLane = lane;
  } else if (getHeader(headers, "x-api-key") !== undefined) {
    effectiveLane = "anthropic";
  } else if (getHeader(headers, "x-goog-api-key") !== undefined) {
    effectiveLane = "google";
  } else {
    effectiveLane = "openai";
  }
  deleteHeader(headers, "authorization");
  if (effectiveLane === "anthropic") {
    deleteHeader(headers, "x-api-key");
    headers["x-api-key"] = "public";
    // The v2 client pins a fixed beta set on messages requests (upstream
    // overrides whatever dynamic list an SDK would derive) and the
    // matching API version. Pi-ai merges options headers last, so these
    // win over its own derived values.
    headers["anthropic-beta"] = ANTHROPIC_BETA;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  } else if (effectiveLane === "google") {
    deleteHeader(headers, "x-goog-api-key");
    headers["x-goog-api-key"] = "public";
  } else {
    headers["Authorization"] = "Bearer public";
  }
}
