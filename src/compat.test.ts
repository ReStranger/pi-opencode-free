// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import opencodeDirectExtension, {
  COMPLETIONS_COMPAT,
  RESPONSES_COMPAT,
} from "./index.js";

// Zen request invariants, asserted against the extension's REAL code
// (compat constants + toProviderModel output), not local mirrors.
// Context: pi-cache-optimizer compatibility (see
// plans/cache-optimizer-compat-report.md §2): Zen payloads must keep
// max_tokens (never renamed to max_completion_tokens), keep
// reasoning_content on assistant messages, and keep tool_calls intact.
// Those payload shapes are produced by Pi's native engines from our
// per-model api + compat fields, so pinning compat here pins the payload.

async function getConfig() {
  let registeredConfig: any = null;
  const fakePi = {
    on() {},
    registerProvider(_id: string, config: any) {
      registeredConfig = config;
    },
  } as unknown as ExtensionAPI;
  await opencodeDirectExtension(fakePi);
  return registeredConfig;
}

async function getHook() {
  let hook: any = null;
  const fakePi = {
    on(event: string, handler: any) {
      if (event === "before_provider_headers") hook = handler;
    },
    registerProvider() {},
  } as unknown as ExtensionAPI;
  await opencodeDirectExtension(fakePi);
  return hook;
}

test("compat constants keep max_tokens and never rename it", async () => {
  assert.equal(COMPLETIONS_COMPAT.maxTokensField, "max_tokens");
  assert.equal("max_completion_tokens" in COMPLETIONS_COMPAT, false);
  assert.equal(RESPONSES_COMPAT.sessionAffinityFormat, "openai-nosession");
});

test("keyless free access applies via header hook and zen engines", async () => {
  const cfg = await getConfig();
  // No provider-level streamSimple: one wrapper could never cover all four
  // backends (Pi's composer routes solely default-engine models through
  // it), so every model points at its stamping `zen-*` engine adapter.
  assert.equal(cfg.streamSimple, undefined);
  assert.equal(cfg.api, "zen-openai-completions");
  const hook = await getHook();
  assert.equal(typeof hook, "function");
  const headers: Record<string, string | null> = {
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    Authorization: "Bearer none",
  };
  hook({ headers });
  assert.equal(headers.Authorization, null);
  assert.equal(headers["x-opencode-client"], "cli");
  assert.match(
    (headers as any)["x-opencode-session"],
    /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
  );
});

test("models carry zen per-model api with stock-style compat and baseUrl routing", async () => {
  const cfg = await getConfig();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("models.dev"))
      return {
        ok: true,
        json: async () => ({
          opencode: {
            models: {
              "muse-spark-1.2-contributor-free": {
                provider: { npm: "@ai-sdk/openai" },
              },
              "minimax-m3-free": { provider: { npm: "@ai-sdk/anthropic" } },
              "gemini-free": { provider: { npm: "@ai-sdk/google" } },
            },
          },
        }),
      };
    return {
      ok: true,
      json: async () => ({
        data: [
          { id: "hy3-free" },
          { id: "muse-spark-1.2-contributor-free" },
          { id: "minimax-m3-free" },
          { id: "gemini-free" },
        ],
      }),
    };
  }) as unknown as typeof fetch;
  try {
    const refreshed = await cfg.refreshModels({
      allowNetwork: true,
      signal: new AbortController().signal,
      stored: undefined,
      publish: async () => true,
    });
    const byId = (id: string) => refreshed.find((m: any) => m.id === id);
    const hy3 = byId("hy3-free");
    const muse = byId("muse-spark-1.2-contributor-free");
    const minimax = byId("minimax-m3-free");
    const gemini = byId("gemini-free");
    // Engine routing mirrors stock opencode.json, via the stamping zen-* adapters.
    assert.equal(hy3?.api, "zen-openai-completions");
    assert.equal(muse?.api, "zen-openai-responses");
    assert.equal(minimax?.api, "zen-anthropic-messages");
    assert.equal(gemini?.api, "zen-google-generative-ai");
    // Compat: completions-only flags stay on the completions engine.
    assert.deepEqual(hy3?.compat, COMPLETIONS_COMPAT);
    assert.equal(hy3?.compat.maxTokensField, "max_tokens");
    assert.deepEqual(muse?.compat, RESPONSES_COMPAT);
    assert.equal(minimax?.compat, undefined); // stock defines none
    assert.equal(gemini?.compat, undefined); // stock defines none
    // Base URLs: default /v1 inherited, Anthropic bare root override.
    assert.equal(hy3?.baseUrl, undefined);
    assert.equal(muse?.baseUrl, undefined);
    assert.equal(minimax?.baseUrl, "https://opencode.ai/zen");
    assert.equal(gemini?.baseUrl, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
