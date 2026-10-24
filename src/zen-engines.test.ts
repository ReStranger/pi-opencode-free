// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  composeZenAnthropicFetch,
  composeZenChatFetch,
  composeZenTransformHeaders,
  createZenEngineFunctions,
  isNativeZenApi,
  isZenApi,
  nativeApiForZen,
  registerZenApiProviders,
  shapeZenV2ChatBody,
  zenApiForNative,
  withAnthropicBeta,
  ZEN_ANTHROPIC_API,
  ZEN_COMPLETIONS_API,
  ZEN_GOOGLE_API,
  ZEN_RESPONSES_API,
  ZEN_V2_CHAT_MAX_COMPLETION_TOKENS,
} from "#src/zen-engines.ts";
import { ZEN_ANTHROPIC_BASE_URL, ZEN_BASE_URL } from "#src/zen-headers.ts";

test("native/zen api mapping round-trips on all four backends", async () => {
  assert.equal(zenApiForNative("openai-completions"), ZEN_COMPLETIONS_API);
  assert.equal(zenApiForNative("openai-responses"), ZEN_RESPONSES_API);
  assert.equal(zenApiForNative("anthropic-messages"), ZEN_ANTHROPIC_API);
  assert.equal(zenApiForNative("google-generative-ai"), ZEN_GOOGLE_API);
  assert.equal(zenApiForNative("totally-made-up-engine"), undefined);
  assert.equal(nativeApiForZen(ZEN_COMPLETIONS_API), "openai-completions");
  assert.equal(nativeApiForZen(ZEN_RESPONSES_API), "openai-responses");
  assert.equal(nativeApiForZen(ZEN_ANTHROPIC_API), "anthropic-messages");
  assert.equal(nativeApiForZen(ZEN_GOOGLE_API), "google-generative-ai");
  // Native ids and garbage never map back (migration stays idempotent).
  assert.equal(nativeApiForZen("openai-completions"), undefined);
  assert.equal(nativeApiForZen("totally-made-up-engine"), undefined);
  assert.equal(nativeApiForZen(undefined), undefined);
  assert.equal(nativeApiForZen(null), undefined);
  assert.equal(isNativeZenApi("anthropic-messages"), true);
  assert.equal(isNativeZenApi(ZEN_ANTHROPIC_API), false);
  assert.equal(isZenApi(ZEN_ANTHROPIC_API), true);
  assert.equal(isZenApi("anthropic-messages"), false);
});

test("registerZenApiProviders registers all four stamping adapters", async () => {
  const registrations: { api: unknown; sourceId?: string }[] = [];
  const ids = registerZenApiProviders(((registration: any, sourceId?: string) => {
    registrations.push({ ...registration, sourceId });
  }) as any);
  assert.deepEqual(ids, [
    ZEN_COMPLETIONS_API,
    ZEN_RESPONSES_API,
    ZEN_ANTHROPIC_API,
    ZEN_GOOGLE_API,
  ]);
  assert.equal(registrations.length, 4);
  for (const reg of registrations) {
    assert.ok(
      (ids as string[]).includes(reg.api as string),
      `registered api is a zen id: ${String(reg.api)}`,
    );
    assert.equal(reg.sourceId, "pi-opencode-free");
    assert.equal(typeof (reg as any).stream, "function");
    assert.equal(typeof (reg as any).streamSimple, "function");
  }
});

test("zen engine adapters stamp and delegate on both stream and streamSimple", async () => {
  const calls: { entry: string; model: any; options: any }[] = [];
  const canned = { marker: "native-engine-stream" };
  const resolveEngine = (_api: any) => ({
    stream: ((model: any, _context: any, options: any) => {
      calls.push({ entry: "stream", model, options });
      return canned as any;
    }) as any,
    streamSimple: ((model: any, _context: any, options: any) => {
      calls.push({ entry: "streamSimple", model, options });
      return canned as any;
    }) as any,
  });
  const functions = createZenEngineFunctions("anthropic-messages", resolveEngine);
  const model = { api: ZEN_ANTHROPIC_API, provider: "opencode-free", id: "x" };
  let parentTransformCalls = 0;
  const options = {
    temperature: 0.5,
    transformHeaders: async (headers: Record<string, string | null>) => {
      parentTransformCalls++;
      return { "x-opencode-client": "pi", ...headers };
    },
  };
  assert.equal((functions.stream as any)(model, [], options), canned);
  assert.equal((functions.streamSimple as any)(model, [], options), canned);
  assert.equal(calls.length, 2);
  for (const { model: nativeModel, options: engineOptions } of calls) {
    // Must re-key to native: pi-ai guards `model.api === api`.
    assert.equal(nativeModel.api, "anthropic-messages");
    assert.equal(nativeModel.provider, "opencode-free");
    assert.equal(nativeModel.id, "x");
    assert.equal(engineOptions.temperature, 0.5); // unrelated options pass through
    const stamped = await engineOptions.transformHeaders({
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      Authorization: "Bearer none",
    });
    assert.equal(stamped["x-opencode-client"], "cli"); // stamp wins over attribution
    assert.match(
      stamped["x-opencode-session"],
      /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    );
    assert.equal(
      stamped["x-opencode-session-id"],
      stamped["x-opencode-session"], // both headers required since 2026-10-14
    );
    assert.equal(stamped["x-opencode-request"], undefined); // instant 403 upstream
    assert.match(stamped["User-Agent"], /^opencode\/[^/]+\/[^/]+\/cli$/);
    assert.equal(stamped.Authorization, "Bearer public"); // placeholder never leaks
  }
  assert.equal(parentTransformCalls, 2); // core transform runs inside the stamp
});

test("zen engine adapters satisfy pi-ai's strict api guard", async () => {
  // Mimics compat's wrapStream/wrapStreamSimple: throws
  // `Mismatched api: <got> expected <want>` when the delegated model keeps
  // the `zen-*` id. Regression test for `zen-openai-responses expected
  // openai-responses`.
  for (const [native, zen] of [
    ["openai-completions", ZEN_COMPLETIONS_API],
    ["openai-responses", ZEN_RESPONSES_API],
    ["anthropic-messages", ZEN_ANTHROPIC_API],
    ["google-generative-ai", ZEN_GOOGLE_API],
  ] as const) {
    const guarded = (model: any) => {
      if (model.api !== native) {
        throw new Error(`Mismatched api: ${model.api} expected ${native}`);
      }
      return { ok: true } as any;
    };
    const functions = createZenEngineFunctions(native, () => ({
      stream: guarded as any,
      streamSimple: guarded as any,
    }));
    const model = { api: zen, provider: "opencode-free", id: "x" };
    assert.deepEqual((functions.stream as any)(model, [], undefined), {
      ok: true,
    });
    assert.deepEqual((functions.streamSimple as any)(model, [], undefined), {
      ok: true,
    });
  }
});

test("zen engine adapters leave foreign traffic untouched", async () => {
  let captured: any = null;
  const functions = createZenEngineFunctions("google-generative-ai", () => ({
    stream: undefined as any,
    streamSimple: ((_model: any, _context: any, options: any) => {
      captured = options;
      return {} as any;
    }) as any,
  }));
  (functions.streamSimple as any)(
    { api: ZEN_GOOGLE_API, provider: "opencode-free", id: "x" },
    [],
    undefined, // no parent transform at all
  );
  const out = await captured.transformHeaders({
    Authorization: "Bearer real-user-key",
  });
  assert.equal(out.Authorization, "Bearer real-user-key");
  assert.equal(out["x-opencode-session"], undefined);
});

test("zen engine adapters fail loud on unknown native engine", async () => {
  const functions = createZenEngineFunctions("openai-responses", () => undefined);
  assert.throws(
    () =>
      (functions.streamSimple as any)(
        { api: ZEN_RESPONSES_API, provider: "opencode-free", id: "x" },
        [],
        undefined,
      ),
    /No API provider registered for api: openai-responses/,
  );
});

test("composeZenTransformHeaders without a parent still stamps", async () => {
  const transform = composeZenTransformHeaders(undefined);
  const out = await transform({
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
  });
  assert.equal(out.Authorization, "Bearer public");
  assert.match(
    (out as any)["x-opencode-session"],
    /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
  );
});

test("withAnthropicBeta appends beta=true and preserves the existing query", () => {
  assert.equal(
    withAnthropicBeta(`${ZEN_ANTHROPIC_BASE_URL}/v1/messages?api=1`),
    `${ZEN_ANTHROPIC_BASE_URL}/v1/messages?api=1&beta=true`,
  );
  // Already flagged: returned unchanged (no double decoration).
  assert.equal(
    withAnthropicBeta(`${ZEN_ANTHROPIC_BASE_URL}/v1/messages?beta=true`),
    `${ZEN_ANTHROPIC_BASE_URL}/v1/messages?beta=true`,
  );
  // Not parseable as a URL: returned as received.
  assert.equal(withAnthropicBeta("not a url"), "not a url");
});

test("anthropic lane rides beta=true only on the Zen base", async () => {
  const seen: string[] = [];
  const parentFetch = ((input: any) => {
    seen.push(String(input));
    return {} as any;
  }) as unknown as typeof fetch;
  let captured: any = null;
  const functions = createZenEngineFunctions("anthropic-messages", () => ({
    stream: ((_model: any, _context: any, options: any) => {
      captured = options;
      return {} as any;
    }) as any,
    streamSimple: undefined as any,
  }));
  (functions.stream as any)(
    { api: ZEN_ANTHROPIC_API, provider: "opencode-free", id: "x" },
    [],
    { fetch: parentFetch } as any,
  );
  const composed = captured?.fetch as
    | ((input: any, init?: any) => Promise<unknown>)
    | undefined;
  assert.ok(composed, "delegated options carry the composed fetch");
  assert.notEqual(composed, parentFetch as unknown);
  // Zen base: beta=true appended, existing query preserved.
  await composed(`${ZEN_ANTHROPIC_BASE_URL}/v1/messages?api=1`);
  // Foreign host passes through byte-identical.
  await composed(new URL("https://example.com/v1/messages?x=1"));
  // Zen base already carrying beta=true is not decorated twice.
  await composed(`${ZEN_ANTHROPIC_BASE_URL}/v1/messages?beta=true`);
  assert.deepEqual(seen, [
    `${ZEN_ANTHROPIC_BASE_URL}/v1/messages?api=1&beta=true`,
    "https://example.com/v1/messages?x=1",
    `${ZEN_ANTHROPIC_BASE_URL}/v1/messages?beta=true`,
  ]);
});

test("composeZenAnthropicFetch rewrites only the Zen base and passes the rest through", async () => {
  const seen: string[] = [];
  const parentFetch = ((input: any) => {
    seen.push(String(input));
    return {} as any;
  }) as unknown as typeof fetch;
  const composed = composeZenAnthropicFetch(parentFetch);
  // Zen base (string input): beta=true appended, existing query preserved.
  await composed(`${ZEN_ANTHROPIC_BASE_URL}/v1/messages?api=1`);
  // URL object input, foreign host: passes through byte-identical.
  await composed(new URL("https://example.com/v1/messages?x=1"));
  // Already-flagged Zen endpoint: not decorated twice.
  await composed(`${ZEN_ANTHROPIC_BASE_URL}/v1/messages?beta=true`);
  assert.deepEqual(seen, [
    `${ZEN_ANTHROPIC_BASE_URL}/v1/messages?api=1&beta=true`,
    "https://example.com/v1/messages?x=1",
    `${ZEN_ANTHROPIC_BASE_URL}/v1/messages?beta=true`,
  ]);
});

test("shapeZenV2ChatBody adds the 2.1 ceiling and keeps the client key order", () => {
  const body = shapeZenV2ChatBody({
    temperature: 0.2,
    stream: true,
    model: "hy3-free",
    messages: [{ role: "user", content: "hi" }],
  });
  const parsed = JSON.parse(body);
  assert.equal(parsed.max_completion_tokens, ZEN_V2_CHAT_MAX_COMPLETION_TOKENS);
  assert.equal(parsed.max_tokens, undefined);
  // The client's own order first (model, messages, stream, ...) then the
  // remaining keys sorted; other keys survive unchanged.
  assert.deepEqual(Object.keys(parsed), [
    "model",
    "messages",
    "stream",
    "max_completion_tokens",
    "temperature",
  ]);
  assert.equal(parsed.temperature, 0.2);
});

test("shapeZenV2ChatBody honours an explicit caller ceiling", () => {
  const explicitCompletion = shapeZenV2ChatBody({
    model: "x",
    messages: [],
    max_completion_tokens: 1234,
  });
  assert.equal(JSON.parse(explicitCompletion).max_completion_tokens, 1234);
  // Legacy max_tokens (what Pi emits before compat kicks in) also suppresses
  // the default ceiling rather than duplicating it.
  const legacy = shapeZenV2ChatBody({
    model: "x",
    messages: [],
    max_tokens: 5678,
  });
  const parsed = JSON.parse(legacy);
  assert.equal(parsed.max_tokens, 5678);
  assert.equal(parsed.max_completion_tokens, undefined);
});

test("shapeZenV2ChatBody pins strict:false on function tools", () => {
  const parsed = JSON.parse(
    shapeZenV2ChatBody({
      model: "x",
      messages: [],
      tools: [
        {
          type: "function",
          function: { name: "shell", description: "run", parameters: {} },
        },
        {
          type: "function",
          function: { name: "read", strict: true, parameters: {} },
        },
        { type: "custom", name: "other" },
        null,
      ],
    }),
  );
  assert.equal(parsed.tools[0].function.strict, false);
  assert.equal(parsed.tools[1].function.strict, true); // explicit value wins
  assert.deepEqual(parsed.tools[2], { type: "custom", name: "other" });
  assert.equal(parsed.tools[3], null);
});

test("shapeZenV2ChatBody does not HTML-escape tool text", () => {
  const body = shapeZenV2ChatBody({
    model: "x",
    messages: [{ role: "user", content: "a < b & c > d" }],
  });
  assert.ok(body.includes("a < b & c > d"));
  assert.ok(!body.includes("\\u003c"));
  assert.ok(!body.includes("\\u0026"));
});

test("composeZenChatFetch rewrites only Zen chat bodies", async () => {
  const calls: { input: any; init: any }[] = [];
  const parentFetch = ((input: any, init?: any) => {
    calls.push({ input, init });
    return {} as any;
  }) as unknown as typeof fetch;
  const composed = composeZenChatFetch(parentFetch);
  const chatUrl = `${ZEN_BASE_URL}/chat/completions`;
  // Zen chat body: reshaped and re-serialized.
  await composed(chatUrl, {
    method: "POST",
    body: JSON.stringify({ model: "x", messages: [], temperature: 0.1 }),
    headers: { "content-type": "application/json" },
  });
  // Foreign host: byte-identical passthrough.
  await composed("https://example.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  // Non-chat Zen path (/responses) stays untouched.
  await composed(`${ZEN_BASE_URL}/responses`, {
    method: "POST",
    body: JSON.stringify({ model: "x", input: [] }),
  });
  // Non-string body (streams): untouched.
  await composed(chatUrl, { method: "POST", body: new Uint8Array([1]) });
  // Invalid JSON: untouched.
  await composed(chatUrl, { method: "POST", body: "{not json" });
  assert.equal(calls[0]!.input, chatUrl);
  const shaped = JSON.parse(calls[0]!.init.body);
  assert.equal(shaped.max_completion_tokens, ZEN_V2_CHAT_MAX_COMPLETION_TOKENS);
  assert.equal(calls[0]!.init.method, "POST");
  assert.deepEqual(calls[0]!.init.headers, {
    "content-type": "application/json",
  });
  assert.equal(
    calls[1]!.init.body,
    JSON.stringify({ model: "x", messages: [] }),
  );
  assert.equal(
    calls[2]!.init.body,
    JSON.stringify({ model: "x", input: [] }),
  );
  assert.ok(calls[3]!.init.body instanceof Uint8Array);
  assert.equal(calls[4]!.init.body, "{not json");
});
