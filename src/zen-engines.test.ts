// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  composeZenTransformHeaders,
  createZenEngineFunctions,
  isNativeZenApi,
  isZenApi,
  nativeApiForZen,
  registerZenApiProviders,
  zenApiForNative,
  ZEN_ANTHROPIC_API,
  ZEN_COMPLETIONS_API,
  ZEN_GOOGLE_API,
  ZEN_RESPONSES_API,
} from "./zen-engines.js";

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
    assert.match(stamped["x-opencode-request"], /^msg_[0-9a-f-]{36}$/);
    assert.equal(stamped.Authorization, null); // placeholder never leaks
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
  assert.equal(out.Authorization, null);
  assert.match(
    (out as any)["x-opencode-session"],
    /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
  );
});
