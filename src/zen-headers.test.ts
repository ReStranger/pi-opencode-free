// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTHROPIC_BETA,
  ANTHROPIC_VERSION,
  applyOpenCodeFreeHeaders,
  canonicalSessionId,
  getHeader,
  OPENCODE_USER_AGENT,
  zenRootSession,
} from "#src/zen-headers.ts";

const GATED = {
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
};

test("session identity is process-stable and shared by all four headers", () => {
  const first: Record<string, string | null> = { ...GATED };
  const second: Record<string, string | null> = { ...GATED };
  applyOpenCodeFreeHeaders(first);
  applyOpenCodeFreeHeaders(second);
  // The v2 sync treats a fresh id per request as a foreign-client signal;
  // the genuine client reuses its session for the life of the process.
  assert.equal(second["x-opencode-session"], first["x-opencode-session"]);
  assert.equal(second["x-session-affinity"], first["x-session-affinity"]);
  // Childless client: the root id is minted once and every session header
  // renders it, exactly the upstream v2 shape (x-session-affinity and
  // X-Session-Id carry the root; x-opencode-session-id the child fallback).
  assert.equal(first["x-opencode-session"], zenRootSession());
  for (const name of [
    "x-session-affinity",
    "X-Session-Id",
    "x-opencode-session-id",
  ]) {
    assert.equal(first[name], first["x-opencode-session"]);
  }
  assert.match(
    first["x-opencode-session"],
    /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
  );
});

test("wire shape matches the v2 client on the default (OpenAI) lane", () => {
  const headers: Record<string, string | null> = {
    ...GATED,
    "x-opencode-request": "r-123", // instant 403 upstream — must be dropped
    Authorization: "Bearer none",
  };
  applyOpenCodeFreeHeaders(headers);
  // The 2.1 client sets no Accept itself, so fetch fills `*/*`; the SDK
  // default `application/json` must never reach the wire (#143).
  assert.equal(headers.Accept, "*/*");
  assert.equal(headers["x-opencode-client"], "cli");
  assert.equal(headers["User-Agent"], OPENCODE_USER_AGENT);
  assert.equal(headers["x-opencode-request"], undefined);
  // Bearer public IS the anonymous credential on this lane.
  assert.equal(headers.Authorization, "Bearer public");
  assert.equal(headers["anthropic-beta"], undefined);
});

test("anthropic lane pins the fixed beta set and API version", () => {
  // Lane sniffed from the preset x-api-key (ambient hook callers state no
  // lane explicitly).
  const headers: Record<string, string | null> = {
    ...GATED,
    "x-api-key": "sk-something",
  };
  applyOpenCodeFreeHeaders(headers);
  assert.equal(headers["x-api-key"], "public");
  assert.equal(headers["anthropic-beta"], ANTHROPIC_BETA);
  assert.equal(headers["anthropic-version"], ANTHROPIC_VERSION);
  // Bearer on the anthropic lane is an instant 403 — never present.
  assert.equal(getHeader(headers, "authorization"), undefined);
  assert.equal(headers.Accept, "*/*");
});

test("explicit lane argument overrides presence sniffing", () => {
  const headers: Record<string, string | null> = {
    ...GATED,
    Authorization: "Bearer none",
  };
  applyOpenCodeFreeHeaders(headers, "anthropic");
  assert.equal(getHeader(headers, "authorization"), undefined);
  assert.equal(headers["x-api-key"], "public");
  assert.equal(headers["anthropic-version"], ANTHROPIC_VERSION);
});

test("foreign traffic without the identity headers stays untouched", () => {
  const headers: Record<string, string | null> = {
    Authorization: "Bearer real-key",
    "User-Agent": "some-other-client/1.0",
  };
  applyOpenCodeFreeHeaders(headers);
  assert.deepEqual(headers, {
    Authorization: "Bearer real-key",
    "User-Agent": "some-other-client/1.0",
  });
});

test("session time part encodes the official 48-bit descending timestamp", () => {
  const timestamp = 1_792_860_221_229;
  const id = canonicalSessionId(timestamp);
  const timePart = id.slice(4, 16);
  assert.match(timePart, /^[0-9a-f]{12}$/);
  // The official Identifier stores ~(ts_ms * 0x1000 + counter) in the low
  // 48 bits; decoding must recover ts_ms modulo 2^36. A 40-bit mask (the
  // pre-fix bug) would recover a much smaller, wrong value here.
  const encoded =
    (~BigInt(`0x${timePart}`) & 0xffffffffffffn) >> 12n;
  assert.equal(encoded, BigInt(timestamp) % (1n << 36n));
});

