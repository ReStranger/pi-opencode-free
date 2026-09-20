// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { discoverModels, filterFreeModels } from "./discovery.js";

test("filterFreeModels filters free models with conservative default metadata", () => {
  const input = [
    { id: "hy3-free", name: "Hy3" },
    { id: "gpt-5.6-sol", name: "Paid Model" },
    { id: "big-pickle", name: "Big Pickle" },
  ];
  const result = filterFreeModels(input);
  assert.deepEqual(
    result.map((m) => m.id),
    ["opencode/hy3-free", "opencode/big-pickle"],
  );
  const [hy3, bigPickle] = result;
  assert.equal(hy3?.reasoning, false); // no catalog, no FALLBACK_META
  assert.equal(hy3?.contextWindow, 128_000);
  assert.equal(bigPickle?.reasoning, false);
});

test("discoverModels returns empty list when zen fetch fails", async () => {
  const failingFetch = async () => {
    throw new Error("Offline");
  };
  const models = await discoverModels({
    fetchFn: failingFetch as typeof fetch,
  });
  assert.deepEqual(models, []);
});

test("discoverModels serves every free model listed by the endpoint", async () => {
  const zenResponse = {
    ok: true,
    json: async () => ({
      data: [
        { id: "hy3-free" },
        { id: "deepseek-v4-flash-free" },
        { id: "gpt-5.6-sol" },
      ],
    }),
  };
  const fetchFn = (async () => zenResponse) as unknown as typeof fetch;

  const models = await discoverModels({ fetchFn });
  // The catalog mirrors the endpoint's free list — no health filtering.
  assert.deepEqual(
    models.map((m) => m.id),
    ["opencode/hy3-free", "opencode/deepseek-v4-flash-free"],
  );
});

test("discoverModels enriches metadata from models.dev before the offline table", async () => {
  const routes = (url: string | URL | Request) => {
    if (String(url).includes("models.dev")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          opencode: {
            models: {
              "x-preview-f-free": {
                reasoning: true,
                reasoning_options: [
                  { type: "effort", values: ["low", "high", "max"] },
                ],
                limit: { context: 1_000_000, output: 131_072 },
                modalities: { input: ["text", "image"] },
              },
            },
          },
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ data: [{ id: "x-preview-f-free" }] }),
    });
  };

  const models = await discoverModels({
    fetchFn: routes as unknown as typeof fetch,
  });
  const x = models.find((m) => m.id === "opencode/x-preview-f-free");
  assert.ok(x, "free model from endpoint must be served");
  assert.equal(x.contextWindow, 1_000_000); // models.dev truth, not the 128K default
  assert.equal(x.maxTokens, 131_072);
  assert.equal(x.reasoning, true);
  assert.equal(x.thinkingLevelMap?.high, "high"); // explicit effort levels survive
  assert.equal(x.thinkingLevelMap?.off, null); // no toggle -> off stays hidden
  assert.deepEqual(x.input, ["text", "image"]); // modality passthrough
});

test("models.dev npm maps to stock-style native engines", () => {
  const routed = filterFreeModels(
    [
      { id: "muse-spark-1.2-contributor-free" },
      { id: "minimax-m3-free" },
      { id: "gemini-3-flash-free" },
    ],
    {
      catalog: {
        "muse-spark-1.2-contributor-free": {
          provider: { npm: "@ai-sdk/openai" },
        },
        "minimax-m3-free": { provider: { npm: "@ai-sdk/anthropic" } },
        "gemini-3-flash-free": { provider: { npm: "@ai-sdk/google" } },
      },
    },
  );
  assert.equal(
    routed.find((m) => m.id === "opencode/muse-spark-1.2-contributor-free")
      ?.api,
    "openai-responses",
  );
  assert.equal(
    routed.find((m) => m.id === "opencode/minimax-m3-free")?.api,
    "anthropic-messages",
  );
  assert.equal(
    routed.find((m) => m.id === "opencode/gemini-3-flash-free")?.api,
    "google-generative-ai",
  );

  const plain = filterFreeModels([{ id: "hy3-free" }], {
    catalog: { "hy3-free": {} },
  });
  assert.equal(plain[0]?.api, undefined); // zen default: chat completions
});

test("discoverModels applies conservative defaults when models.dev is unreachable", async () => {
  const routes = (url: string | URL | Request) => {
    if (String(url).includes("models.dev"))
      return Promise.reject(new Error("Offline"));
    return Promise.resolve({
      ok: true,
      json: async () => ({ data: [{ id: "hy3-free" }] }),
    });
  };

  const models = await discoverModels({
    fetchFn: routes as unknown as typeof fetch,
  });
  const hy3 = models.find((m) => m.id === "opencode/hy3-free");
  assert.ok(hy3);
  assert.equal(hy3.contextWindow, 128_000); // default, not stale hardcoded value
});

test("catalog timeout uses a separate signal from Zen discovery", async () => {
  let zenSignal: AbortSignal | undefined;
  let catalogSignal: AbortSignal | undefined;
  const routes = (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("models.dev")) {
      catalogSignal = init?.signal ?? undefined;
      return Promise.resolve({ ok: false });
    }
    zenSignal = init?.signal ?? undefined;
    return Promise.resolve({
      ok: true,
      json: async () => ({ data: [{ id: "hy3-free" }] }),
    });
  };

  const models = await discoverModels({
    fetchFn: routes as unknown as typeof fetch,
  });
  assert.equal(models.length, 1);
  assert.ok(zenSignal);
  assert.ok(catalogSignal);
  assert.notEqual(zenSignal, catalogSignal);
});

test("discoverModels re-applies previous enrichment when the catalog is unreachable", async () => {
  const routes = (url: string | URL | Request) => {
    if (String(url).includes("models.dev"))
      return Promise.reject(new Error("Offline"));
    return Promise.resolve({
      ok: true,
      json: async () => ({ data: [{ id: "hy3-free" }] }),
    });
  };
  const models = await discoverModels({
    fetchFn: routes as unknown as typeof fetch,
    previous: [
      {
        id: "opencode/hy3-free",
        name: "Hy3 Custom",
        reasoning: true,
        contextWindow: 256_000,
        maxTokens: 64_000,
        thinkingLevelMap: { low: "low", off: null },
        input: ["text", "image"],
        api: "openai-responses",
      },
    ],
  });
  const hy3 = models.find((m) => m.id === "opencode/hy3-free");
  assert.ok(hy3);
  assert.equal(hy3.reasoning, true); // not wiped to false
  assert.equal(hy3.contextWindow, 256_000);
  assert.equal(hy3.maxTokens, 64_000);
  assert.deepEqual(hy3.thinkingLevelMap, { low: "low", off: null });
  assert.deepEqual(hy3.input, ["text", "image"]);
  assert.equal(hy3.api, "openai-responses");
});

test("discoverModels lets fresh catalog truth win over previous snapshot", async () => {
  const routes = (url: string | URL | Request) => {
    if (String(url).includes("models.dev")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          opencode: {
            models: {
              "hy3-free": {
                name: "Hy3 Fresh",
                reasoning: true,
                limit: { context: 500_000, output: 32_000 },
              },
            },
          },
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ data: [{ id: "hy3-free" }] }),
    });
  };
  const models = await discoverModels({
    fetchFn: routes as unknown as typeof fetch,
    previous: [
      {
        id: "opencode/hy3-free",
        name: "Hy3 Stale",
        reasoning: true,
        contextWindow: 256_000,
        maxTokens: 64_000,
      },
    ],
  });
  const hy3 = models.find((m) => m.id === "opencode/hy3-free");
  assert.ok(hy3);
  assert.equal(hy3.contextWindow, 500_000); // fresh catalog, not stale snapshot
  assert.equal(hy3.name, "Hy3 Fresh");
});

test("discoverModels enriches per-model when the catalog lacks an entry", async () => {
  const routes = (url: string | URL | Request) => {
    if (String(url).includes("models.dev")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          opencode: {
            models: {
              "fresh-free": {
                reasoning: true,
                limit: { context: 900_000, output: 90_000 },
              },
            },
          },
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ data: [{ id: "fresh-free" }, { id: "stale-free" }] }),
    });
  };
  const models = await discoverModels({
    fetchFn: routes as unknown as typeof fetch,
    previous: [
      {
        id: "stale-free",
        name: "Stale",
        reasoning: true,
        contextWindow: 111_000,
        maxTokens: 11_000,
      },
      {
        id: "fresh-free",
        name: "Stale Fresh",
        reasoning: true,
        contextWindow: 1,
        maxTokens: 1,
      },
    ],
  });
  const stale = models.find((m) => m.id === "opencode/stale-free");
  assert.ok(stale);
  assert.equal(stale.reasoning, true); // per-model fill despite catalog ok
  assert.equal(stale.contextWindow, 111_000);
  const fresh = models.find((m) => m.id === "opencode/fresh-free");
  assert.ok(fresh);
  assert.equal(fresh.contextWindow, 900_000); // catalog truth wins
});

test("discoverModels keeps defaults for ids absent from previous snapshot", async () => {
  const routes = (url: string | URL | Request) => {
    if (String(url).includes("models.dev"))
      return Promise.reject(new Error("Offline"));
    return Promise.resolve({
      ok: true,
      json: async () => ({ data: [{ id: "brand-new-free" }] }),
    });
  };
  const models = await discoverModels({
    fetchFn: routes as unknown as typeof fetch,
    previous: [
      {
        id: "opencode/other-free",
        name: "Other",
        reasoning: true,
        contextWindow: 777_000,
        maxTokens: 77_000,
      },
    ],
  });
  const fresh = models.find((m) => m.id === "opencode/brand-new-free");
  assert.ok(fresh);
  assert.equal(fresh.reasoning, false);
  assert.equal(fresh.contextWindow, 128_000);
});

test("discoverModels rejects oversized or non-JSON catalog payloads", async () => {
  const routes = (url: string | URL | Request) => {
    if (String(url).includes("models.dev")) {
      return Promise.resolve({
        ok: true,
        headers: new Headers({
          "content-length": "999999999",
          "content-type": "application/json",
        }),
        json: async () => ({ opencode: { models: {} } }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ data: [{ id: "hy3-free" }] }),
    });
  };
  const models = await discoverModels({
    fetchFn: routes as unknown as typeof fetch,
    previous: [
      {
        id: "opencode/hy3-free",
        name: "Hy3",
        reasoning: true,
        contextWindow: 222_000,
        maxTokens: 22_000,
      },
    ],
  });
  // Oversized catalog refused -> previous enrichment applies.
  const hy3 = models.find((m) => m.id === "opencode/hy3-free");
  assert.ok(hy3);
  assert.equal(hy3.reasoning, true);
  assert.equal(hy3.contextWindow, 222_000);
});

test("discoverModels returns empty list when fetch times out or aborts", async () => {
  const hangingFetch = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("Timeout", "AbortError")),
      );
    });

  const models = await discoverModels({
    fetchFn: hangingFetch as unknown as typeof fetch,
    timeoutMs: 10,
  });
  assert.deepEqual(models, []);
});
