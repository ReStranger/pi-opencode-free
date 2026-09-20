// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import opencodeDirectExtension, { createZenStreamSimple } from "./index.js";
import { discoverModels } from "./discovery.js";
import { getApiProvider } from "@earendil-works/pi-ai/compat";

type HeaderEvent = { headers: Record<string, string | null> };
type HeaderHandler = (event: HeaderEvent) => void;

test("registers provider once with empty initial models and no boot fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount++;
    throw new Error("must not fetch");
  }) as typeof fetch;
  try {
    let registeredId = "";
    let registeredConfig: any = null;
    const hooks: { headersHandler?: HeaderHandler } = {};
    const fakePi = {
      on(event: string, handler: HeaderHandler) {
        if (event === "before_provider_headers") hooks.headersHandler = handler;
      },
      registerProvider(id: string, config: any) {
        registeredId = id;
        registeredConfig = config;
      },
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);
    assert.equal(registeredId, "opencode-free");
    assert.equal(fetchCount, 0); // no fetch during extension load
    assert.deepEqual(registeredConfig.models, []); // populated by refreshModels
    assert.equal(registeredConfig.api, "zen-openai-completions"); // per-model default engine (not a dispatch change — every model carries its own zen-* api)
    assert.equal(registeredConfig.baseUrl, "https://opencode.ai/zen/v1");
    assert.equal(registeredConfig.name, "OpenCode Direct (Free)");
    assert.equal(registeredConfig.apiKey, "none"); // keyless placeholder (Pi core requires an auth method; the hook/wrapper null it on every request)
    assert.equal(registeredConfig.headers["x-opencode-client"], "cli");
    assert.equal(registeredConfig.headers["x-opencode-project"], "global");
    assert.equal(registeredConfig.headers["User-Agent"], "opencode/1.18.31");
    assert.match(
      registeredConfig.headers["x-opencode-session"],
      /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, // canonical fallback for paths without per-request stamping (foreground children on non-completions engines)
    );
    assert.match(
      registeredConfig.headers["x-opencode-request"],
      /^msg_[0-9a-f-]{36}$/,
    );
    assert.equal(registeredConfig.headers.Authorization, undefined);
    assert.equal(registeredConfig.authHeader, undefined); // no authHeader: Pi-native stored keys are never exposed as Bearer
    assert.equal(typeof hooks.headersHandler, "function");
    const headers: Record<string, string | null> = {
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      Authorization: "Bearer none",
    };
    assert.ok(hooks.headersHandler);
    hooks.headersHandler({ headers });
    assert.match(
      headers["x-opencode-session"]!,
      /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    );
    assert.match(headers["x-opencode-request"]!, /^msg_[0-9a-f-]{36}$/);
    assert.equal(headers["User-Agent"], "opencode/1.18.31");
    assert.equal(headers.Authorization, null);
    assert.equal(typeof registeredConfig.refreshModels, "function");
    // No provider-level streamSimple: Pi's composer would route solely the
    // default-engine models through it, so stamping lives in the zen-*
    // engine adapters (registered as a side effect of extension load) that
    // every backend travels through — including in foreground (async:false)
    // children that inherit the provider but no ambient hooks.
    assert.equal(registeredConfig.streamSimple, undefined);
    for (const api of [
      "zen-openai-completions",
      "zen-openai-responses",
      "zen-anthropic-messages",
      "zen-google-generative-ai",
    ] as const) {
      const engine = getApiProvider(api);
      assert.ok(engine, `zen engine registered: ${api}`);
      assert.equal(typeof engine.stream, "function");
      assert.equal(typeof engine.streamSimple, "function");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("module exports are defined and functions", () => {
  assert.equal(typeof opencodeDirectExtension, "function");
  assert.equal(typeof discoverModels, "function");
});

test("package.json is configured for public release and distribution", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.private, undefined, "package must not be private");
  assert.equal(pkg.license, "GPL-3.0-or-later");
  assert.deepEqual(pkg.pi?.extensions, ["./index.ts"]);
  assert.ok(pkg.files?.includes("dist"));
  assert.ok(pkg.scripts?.prepack);
});

test("cache-only refresh restores persisted snapshot without network", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("must not fetch");
  }) as typeof fetch;
  try {
    let registeredConfig: any = null;
    const fakePi = {
      on() {},
      registerProvider(_id: string, config: any) {
        registeredConfig = config;
      },
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);

    const completionsModel = {
      id: "hy3-free",
      name: "Hy3 (Free)",
      api: "openai-completions",
      provider: "opencode-free",
      baseUrl: "https://opencode.ai/zen/v1",
      reasoning: true,
      input: ["text"],
      contextWindow: 256_000,
      maxTokens: 64_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
      },
    };
    const responsesModel = {
      ...completionsModel,
      id: "muse-spark-1.2-contributor-free",
      name: "Muse Spark 1.2 Free",
      api: "openai-responses",
    };
    const anthropicModel = {
      ...completionsModel,
      id: "minimax-m3-free",
      name: "MiniMax M3 Free",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen",
    };
    const restored = await registeredConfig.refreshModels({
      allowNetwork: false,
      signal: new AbortController().signal,
      stored: { models: [completionsModel, responsesModel, anthropicModel] },
      publish: async () => true,
    });
    assert.equal(restored.length, 3);
    assert.equal(restored[0].id, "hy3-free"); // stripped back to config shape
    assert.equal(restored[0].contextWindow, 256_000);
    assert.equal((restored[0] as any).provider, undefined); // provider/baseUrl removed
    assert.equal((restored[0] as any).baseUrl, undefined); // default baseUrl inherited from provider
    assert.equal((restored[1] as any).api, "zen-openai-responses"); // zen engine per model
    assert.equal((restored[2] as any).api, "zen-anthropic-messages");
    assert.equal((restored[2] as any).baseUrl, "https://opencode.ai/zen"); // non-default baseUrl preserved
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cache-only refresh migrates legacy opencodeApi snapshots", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("must not fetch");
  }) as typeof fetch;
  try {
    let registeredConfig: any = null;
    const fakePi = {
      on() {},
      registerProvider(_id: string, config: any) {
        registeredConfig = config;
      },
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);
    const restored = await registeredConfig.refreshModels({
      allowNetwork: false,
      signal: new AbortController().signal,
      stored: {
        models: [
          {
            id: "muse-spark-1.2-contributor-free",
            api: "openai-completions",
            opencodeApi: "openai-responses",
            provider: "opencode-free",
            baseUrl: "https://opencode.ai/zen/v1",
          },
        ],
      },
      publish: async () => true,
    });
    assert.equal(restored.length, 1);
    assert.equal((restored[0] as any).api, "zen-openai-responses"); // migrated to zen engine
    assert.equal((restored[0] as any).opencodeApi, undefined);
    assert.equal((restored[0] as any).provider, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cache-only refresh with no stored snapshot yields empty list", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("must not fetch");
  }) as typeof fetch;
  try {
    let registeredConfig: any = null;
    const fakePi = {
      on() {},
      registerProvider(_id: string, config: any) {
        registeredConfig = config;
      },
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);
    const restored = await registeredConfig.refreshModels({
      allowNetwork: false,
      signal: new AbortController().signal,
      stored: undefined,
      publish: async () => true,
    });
    assert.deepEqual(restored, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("network refresh discovers models and persists a stamped snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const zenResponse = {
    ok: true,
    json: async () => ({ data: [{ id: "hy3-free", name: "Hy3" }] }),
  };
  let published: any = null;
  globalThis.fetch = (async () => zenResponse) as unknown as typeof fetch;
  try {
    let registeredConfig: any = null;
    const fakePi = {
      on() {},
      registerProvider(_id: string, config: any) {
        registeredConfig = config;
      },
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);

    const refreshed = await registeredConfig.refreshModels({
      allowNetwork: true,
      signal: new AbortController().signal,
      stored: undefined,
      publish: async (publication: any) => {
        published = publication;
        return true;
      },
    });

    assert.equal(refreshed[0].id, "hy3-free");
    assert.equal(refreshed[0].compat.maxTokensField, "max_tokens"); // config shape
    assert.ok(published, "persist must be called on successful discovery");
    assert.equal(published.persist.models[0].provider, "opencode-free"); // stamped
    assert.equal(published.persist.models[0].api, "zen-openai-completions");
    assert.equal(typeof published.persist.checkedAt, "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("network refresh never wipes a good snapshot when discovery comes back empty", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("Offline");
  }) as typeof fetch;
  try {
    let registeredConfig: any = null;
    let publishCalled = false;
    const fakePi = {
      on() {},
      registerProvider(_id: string, config: any) {
        registeredConfig = config;
      },
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);
    const refreshed = await registeredConfig.refreshModels({
      allowNetwork: true,
      signal: new AbortController().signal,
      stored: {
        models: [
          { id: "old", provider: "opencode-free", api: "openai-completions" },
        ],
      },
      publish: async () => {
        publishCalled = true;
        return true;
      },
    });
    assert.deepEqual(refreshed, []);
    assert.equal(publishCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("network refresh respects abort signal before fetching", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount++;
    return { ok: true };
  }) as unknown as typeof fetch;
  try {
    let registeredConfig: any = null;
    const fakePi = {
      on() {},
      registerProvider(_id: string, config: any) {
        registeredConfig = config;
      },
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);
    const controller = new AbortController();
    controller.abort();
    const refreshed = await registeredConfig.refreshModels({
      allowNetwork: true,
      signal: controller.signal,
      stored: undefined,
      publish: async () => true,
    });
    assert.deepEqual(refreshed, []);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("registers no slash commands", async () => {
  const calls: string[] = [];
  const fakePi = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "then") return undefined;
        return (..._args: unknown[]) => {
          calls.push(String(prop));
        };
      },
    },
  ) as unknown as ExtensionAPI;
  await opencodeDirectExtension(fakePi);
  assert.deepEqual(
    calls.filter((c) => c.toLowerCase().includes("command")),
    [],
  );
});

async function loadWithHeaderHook() {
  const hooks: { headersHandler?: HeaderHandler } = {};
  const fakePi = {
    on(event: string, handler: HeaderHandler) {
      if (event === "before_provider_headers") hooks.headersHandler = handler;
    },
    registerProvider() {},
  } as unknown as ExtensionAPI;
  await opencodeDirectExtension(fakePi);
  assert.ok(hooks.headersHandler, "header hook must be registered");
  return hooks.headersHandler!;
}

test("header hook leaves non-opencode traffic untouched", async () => {
  const handle = await loadWithHeaderHook();
  const headers: Record<string, string | null> = {
    Authorization: "Bearer real-user-key",
  };
  handle({ headers }); // no cli/project markers at all
  assert.equal(headers.Authorization, "Bearer real-user-key");
  assert.equal(headers["x-opencode-session"], undefined);
  assert.equal(headers["x-opencode-request"], undefined);
  assert.equal(headers["User-Agent"], undefined);
});

test("header hook is a no-op when x-opencode-project is missing", async () => {
  const handle = await loadWithHeaderHook();
  const headers: Record<string, string | null> = {
    "x-opencode-client": "cli",
    Authorization: "Bearer none",
  };
  handle({ headers });
  assert.equal(headers.Authorization, "Bearer none");
  assert.equal(headers["x-opencode-session"], undefined);
});

test("header hook strips any credential on own traffic (pure keyless)", async () => {
  const handle = await loadWithHeaderHook();
  const headers: Record<string, string | null> = {
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    Authorization: "Bearer sk-live-user-key",
  };
  handle({ headers });
  assert.equal(headers.Authorization, null);
  // Identity is still stamped (compaction and normal turns share this path).
  assert.match(
    headers["x-opencode-session"]!,
    /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
  );
  assert.match(headers["x-opencode-request"]!, /^msg_[0-9a-f-]{36}$/);
  assert.equal(headers["User-Agent"], "opencode/1.18.31");
  assert.equal(headers["x-opencode-client"], "cli");
});

test("header hook nulls lowercase authorization and native api-key headers", async () => {
  const handle = await loadWithHeaderHook();
  const headers: Record<string, string | null> = {
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    authorization: "Bearer none", // fetch/Undici-normalized casing
    "x-api-key": "none",
    "X-Goog-Api-Key": "none",
    "user-agent": "custom/9.9",
  };
  handle({ headers });
  assert.ok(
    !("authorization" in headers),
    "lowercase authorization must not survive",
  );
  assert.equal(headers.Authorization, null);
  assert.equal(headers["x-api-key"], null);
  assert.equal(headers["x-goog-api-key"], null); // normalized to lowercase
  assert.ok(!("X-Goog-Api-Key" in headers), "mixed-case variant must not survive");
  assert.equal(headers["User-Agent"], "opencode/1.18.31");
  assert.ok(!("user-agent" in headers), "lowercase user-agent must not survive");
});

test("header hook leaves absent x-api-key alone", async () => {
  const handle = await loadWithHeaderHook();
  const headers: Record<string, string | null> = {
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
  };
  handle({ headers });
  // OpenAI path still nulls to block `apiKey: "none"`; native key headers
  // stay absent (never added when missing).
  assert.equal(headers.Authorization, null);
  assert.equal("x-api-key" in headers, false);
  assert.equal("x-goog-api-key" in headers, false);
  assert.ok(headers["x-opencode-session"]);
});

test("provider streamSimple stamps Zen identity without ambient hooks (foreground path)", async () => {
  // Fake native engine: captures what the wrapper forwards and returns a
  // canned stream, like an engine adapter would.
    let received: any = null;
    const cannedStream = { marker: "engine-stream" };
    const wrapper = createZenStreamSimple(() => ({
      streamSimple: ((model: any, context: any, options: any) => {
        received = { model, context, options };
        return cannedStream as any;
      }) as any,
    }));
    const model = {
      api: "openai-completions",
      provider: "opencode-free",
      id: "hy3-free",
      baseUrl: "https://opencode.ai/zen/v1",
    };
    const context = [{ role: "user", content: "hi" }];
    // Foreground child streamFn: attribution merged UNDER the assembled
    // headers (provider-static wins) — faithful to
    // mergeProviderAttributionHeaders order; no hook runs in-process.
    let parentTransformCalls = 0;
    const inputOptions = {
      temperature: 0.5,
      transformHeaders: async (headers: Record<string, string | null>) => {
        parentTransformCalls++;
        return {
          "x-opencode-client": "pi",
          "x-opencode-session": "raw-pi-session-id",
          ...headers,
        };
      },
    };
    const out = (wrapper as any)(model, context, inputOptions);
    assert.equal(out, cannedStream); // transparent delegation
    assert.equal(received.model, model);
    assert.equal(received.context, context);
    assert.equal(received.options.temperature, 0.5); // unrelated options pass through
    assert.equal(typeof received.options.transformHeaders, "function");
    // What a native engine adapter would do with the composed transform:
    const engineHeaders = {
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      "x-opencode-session": "ses_staticfallback000000000000",
      "User-Agent": "old-agent",
      Authorization: "Bearer none",
    };
    const first = await received.options.transformHeaders(engineHeaders);
    assert.equal(parentTransformCalls, 1); // core transform runs first
    assert.equal(first["x-opencode-client"], "cli"); // wrapper restores cli over attribution's pi
    assert.match(first["x-opencode-session"], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.notEqual(first["x-opencode-session"], "ses_staticfallback000000000000"); // fresh, not the static fallback
    assert.match(first["x-opencode-request"], /^msg_[0-9a-f-]{36}$/);
    assert.equal(first["User-Agent"], "opencode/1.18.31");
    assert.equal(first.Authorization, null); // placeholder never leaks
    const second = await received.options.transformHeaders(engineHeaders);
    assert.notEqual(
      second["x-opencode-session"],
      first["x-opencode-session"],
      "every request gets fresh canonical ids (retries reuse headers)",
  );
});

test("provider streamSimple leaves foreign traffic untouched", async () => {
  let received: any = null;
  const wrapper = createZenStreamSimple(() => ({
    streamSimple: ((_model: any, _context: any, options: any) => {
      received = options;
      return {} as any;
    }) as any,
  }));
  const model = { api: "openai-completions", provider: "opencode-free", id: "x" };
  (wrapper as any)(model, [], undefined); // no parent transform at all
  const headers = { Authorization: "Bearer real-user-key" };
  const out = await received.transformHeaders(headers);
  assert.equal(out.Authorization, "Bearer real-user-key"); // no cli/project markers → no-op
  assert.equal(out["x-opencode-session"], undefined);
});

test("provider streamSimple fails loud on unknown engine (native parity)", () => {
  const wrapper = createZenStreamSimple(() => undefined);
  const model = { api: "no-such-engine", provider: "opencode-free", id: "x" };
  assert.throws(
    () => (wrapper as any)(model, [], undefined),
    /No API provider registered for api: no-such-engine/,
  );
});

test("cache-only refresh re-derives anthropic baseUrl from legacy snapshots", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("must not fetch");
  }) as typeof fetch;
  try {
    let registeredConfig: any = null;
    const fakePi = {
      on() {},
      registerProvider(_id: string, config: any) {
        registeredConfig = config;
      },
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);
    const restored = await registeredConfig.refreshModels({
      allowNetwork: false,
      signal: new AbortController().signal,
      stored: {
        models: [
          {
            // Legacy layout: everything was forced through /v1 with opencodeApi.
            id: "minimax-m3-free",
            api: "openai-completions",
            opencodeApi: "anthropic-messages",
            provider: "opencode-free",
            baseUrl: "https://opencode.ai/zen/v1",
          },
        ],
      },
      publish: async () => true,
    });
    assert.equal(restored.length, 1);
    assert.equal((restored[0] as any).api, "zen-anthropic-messages");
    assert.equal((restored[0] as any).baseUrl, "https://opencode.ai/zen");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cache-only refresh drops poisoned baseUrl and unknown api", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("must not fetch");
  }) as typeof fetch;
  try {
    let registeredConfig: any = null;
    const fakePi = {
      on() {},
      registerProvider(_id: string, config: any) {
        registeredConfig = config;
      },
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);
    const restored = await registeredConfig.refreshModels({
      allowNetwork: false,
      signal: new AbortController().signal,
      stored: {
        models: [
          {
            id: "evil",
            api: "openai-completions",
            provider: "opencode-free",
            baseUrl: "https://evil.example/",
          },
          {
            id: "weird",
            api: "totally-made-up-engine",
            provider: "opencode-free",
          },
          "not-an-object",
          null,
        ],
      },
      publish: async () => true,
    });
    assert.equal(restored.length, 2);
    assert.equal((restored[0] as any).id, "evil");
    assert.equal((restored[0] as any).baseUrl, undefined); // evil URL dropped
    assert.equal((restored[1] as any).id, "weird");
    assert.equal((restored[1] as any).api, undefined); // unknown api sanitized to default
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("google backend gets no completions-only compat flags", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("must not fetch");
  }) as typeof fetch;
  try {
    let registeredConfig: any = null;
    const fakePi = {
      on() {},
      registerProvider(_id: string, config: any) {
        registeredConfig = config;
      },
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);
    const restored = await registeredConfig.refreshModels({
      allowNetwork: false,
      signal: new AbortController().signal,
      stored: {
        models: [
          {
            id: "gemini-free",
            api: "google-generative-ai",
            provider: "opencode-free",
          },
        ],
      },
      publish: async () => true,
    });
    assert.equal(restored.length, 1);
    assert.equal((restored[0] as any).api, "zen-google-generative-ai");
    assert.equal((restored[0] as any).compat, undefined); // stock defines none
  } finally {
    globalThis.fetch = originalFetch;
  }
});
