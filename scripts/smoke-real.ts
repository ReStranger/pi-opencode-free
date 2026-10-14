// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-scenario smoke test against the live OpenCode Zen API, exercising the
 * extension's exact provider config via the registered `zen-*` engine
 * adapters (the same stamping path every backend travels in production).
 * Run with: bun scripts/smoke-real.ts
 */
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  Tool,
} from "@earendil-works/pi-ai";
import { discoverModels } from "../src/discovery.js";
import {
  OPENCODE_USER_AGENT,
  ZEN_ANTHROPIC_BASE_URL,
  ZEN_BASE_URL,
  applyOpenCodeFreeHeaders,
  canonicalSessionId,
} from "../src/zen-headers.js";
import {
  nativeApiForZen,
  registerZenApiProviders,
  zenApiForNative,
  ZEN_COMPLETIONS_API,
} from "../src/zen-engines.js";
// Imported, never mirrored: compat flags must match production exactly.
import { COMPLETIONS_COMPAT, RESPONSES_COMPAT } from "../src/index.js";

registerZenApiProviders();

const HEADERS = {
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
  "x-opencode-session": canonicalSessionId(),
  "User-Agent": OPENCODE_USER_AGENT,
};

/**
 * Mirrors src/index.ts: per-model api selects the registered `zen-*` engine
 * adapter (stamping + native dispatch). Headers are pre-stamped here the
 * way Pi core's streamFn + before_provider_headers hook would stamp them in
 * production; the adapter's composed transform then stamps them again on
 * dispatch. Kept in sync via the shared zen-headers module — do not
 * hand-roll header logic here.
 */
function shimStream(model: any, context: Context, options?: any) {
  const engine = getApiProvider(model.api);
  if (!engine) {
    throw new Error(`No API provider registered for api: ${model.api}`);
  }
  const headers: Record<string, string | null> = {
    ...options?.headers,
    ...HEADERS,
  };
  // Pre-stamp the way Pi core + the ambient hook would (openai-lane by
  // default); the zen adapter re-stamps with the backend's real lane next.
  const native = nativeApiForZen(model.api);
  applyOpenCodeFreeHeaders(
    headers,
    native === "anthropic-messages"
      ? "anthropic"
      : native === "google-generative-ai"
        ? "google"
        : "openai",
  );
  return engine.streamSimple(model, context, { ...options, headers });
}

function toPiModel(m: Awaited<ReturnType<typeof discoverModels>>[number]): any {
  // Mirrors src/index.ts toProviderModel (model SHAPE only — the compat and
  // engine constants above/below are imported, not copied): zen-* engine
  // routing with stock-style compat/baseUrl (completions quirks apply only
  // to openai-completions; Anthropic/Google engines get no compat).
  const api = zenApiForNative(m.api ?? "openai-completions") ?? ZEN_COMPLETIONS_API;
  const native = nativeApiForZen(api) ?? "openai-completions";
  return {
    id: m.id.replace(/^opencode\//, ""),
    name: m.name,
    api,
    provider: "opencode-free",
    baseUrl:
      native === "anthropic-messages" ? ZEN_ANTHROPIC_BASE_URL : ZEN_BASE_URL,
    reasoning: m.reasoning ?? false,
    thinkingLevelMap: m.thinkingLevelMap,
    input: ["text"],
    contextWindow: m.contextWindow ?? 128_000,
    maxTokens: m.maxTokens ?? 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat:
      native === "openai-responses"
        ? RESPONSES_COMPAT
        : native === "openai-completions"
          ? COMPLETIONS_COMPAT
          : undefined,
    headers: HEADERS,
  };
}

async function run(model: Model<Api>, context: Context, opts?: any) {
  const events: AssistantMessageEvent[] = [];
  const stream = shimStream(model, context, { apiKey: "none", ...opts });
  let final: any = null;
  for await (const ev of stream) {
    events.push(ev);
    if (ev.type === "done") final = ev.message;
    if (ev.type === "error") final = ev.error;
  }
  return { events, final };
}

function textOf(msg: any): string {
  return (msg?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Upstream error text for a failed run (any stopReason). */
function errorText(final: any): string {
  const direct = final?.errorMessage ?? "";
  if (typeof direct === "string") return direct;
  return JSON.stringify(final); // errors carry nested provider info
}

const SKIP_PATTERNS = [
  /does not support this protocol/i, // upstream model/protocol routing, not our lane
  /Rate limit exceeded/i, // FreeUsageLimitError: gate passed, quota tripped
];

/** Runs the runner over candidates until one succeeds; frees gate-side skips. */
async function runModelProbe(
  label: string,
  candidates: typeof models,
  runFn: (m: (typeof models)[number]) => Promise<boolean>,
) {
  let sawRateLimitOnly = candidates.length > 0;
  for (const candidate of candidates) {
    console.log(`   -- trying ${candidate.id} --`);
    try {
      const ok = await runFn(candidate);
      check(label, ok, `model=${candidate.id}`);
      return;
    } catch (error: any) {
      const text = String(error?.message ?? error);
      if (/FreeTierError/i.test(text)) {
        check(label, false, `403 FreeTierError on ${candidate.id}`);
        return;
      }
      if (SKIP_PATTERNS.some((p) => p.test(text))) {
        sawRateLimitOnly = sawRateLimitOnly && /Rate limit exceeded/i.test(text);
        console.log(`   -- skip ${candidate.id}: upstream skip (${text.slice(0, 80)}) --`);
        continue;
      }
      throw error;
    }
  }
  if (sawRateLimitOnly) {
    console.log(`SKIP  ${label} — free-tier quota exhausted on every candidate (gate itself passed; retry later)`);
  } else {
    check(label, false, "all candidates skipped (protocol routing)");
  }
}

const isSkipable = (final: any): boolean =>
  SKIP_PATTERNS.some((p) => p.test(errorText(final)));

console.log("== 1. Live model discovery from OpenCode Zen ==");
const models = await discoverModels();
console.log(`   endpoint lists ${models.length} free models (all served): ${models.map(m => m.id).join(", ")}`);
check("discovery returns free models", models.length > 0);
check(
  "all discovered ids match the free regex",
  models.every(m => /(^(opencode\/)?.*-free$)|(^(opencode\/)?big-pickle$)/i.test(m.id)),
);

const nonReasoning = models.filter(m => !m.reasoning);
// Chat lanes: non-reasoning models first, but any free model may serve the
// lane (only its own protocol table decides) — fall back to reasoning models.
const chatCandidates = [...nonReasoning, ...models.filter(m => m.reasoning)];
console.log("\n== 2. Plain chat via zen engine ==");
await runModelProbe("plain chat", chatCandidates, async (m) => {
  const { final } = await run(toPiModel(m), {
    systemPrompt: "You are terse.",
    messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: Date.now() }],
  }, { maxTokens: 200 });
  if (final?.stopReason === "error" && isSkipable(final)) {
    throw new Error(errorText(final));
  }
  const ok = final?.stopReason === "stop" && /OK/i.test(textOf(final));
  console.log(`      model=${m.id} stopReason=${final?.stopReason} text="${textOf(final).trim().slice(0, 60)}"`);
  return ok && (final?.usage?.output ?? 0) > 0;
});

// Prefer reasoning models confirmed alive on the free tier: deepseek is still
// listed but its free promotion ended server-side and returns 401.
const reasoner =
  models.find(m => m.reasoning && m.id.includes("hy3")) ??
  models.find(m => m.reasoning && m.thinkingLevelMap?.low);
if (reasoner) {
  console.log(`\n== 3. Reasoning stream via zen engine (${reasoner.id}, level=low) ==`);
  const { final } = await run(toPiModel(reasoner), {
    systemPrompt: "You are terse.",
    messages: [{ role: "user", content: "What is 17*23? Think briefly, then answer.", timestamp: Date.now() }],
  }, { maxTokens: 2000, reasoning: "low" });
  const hasThinking = (final?.content ?? []).some((b: any) => b.type === "thinking");
  const hasText = textOf(final).length > 0;
  check("reasoning completion succeeds", final?.stopReason === "stop", `stopReason=${final?.stopReason}`);
  check("thinking block present", hasThinking);
  check("answer text present", hasText, `"${textOf(final).trim().slice(0, 60)}"`);
} else {
  console.log("\n== 3. Skipped: no reasoning model with low effort in discovery ==");
}

console.log("\n== 4. Native tool calling ==");
await runModelProbe("native tool calling", chatCandidates, async (m) => {
  const model = toPiModel(m);
  const weather: Tool = {
    name: "get_weather",
    description: "Get current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  };
  const { final } = await run(model, {
    systemPrompt: "You must use the get_weather tool to answer weather questions.",
    messages: [{ role: "user", content: "What's the weather in Lisbon?", timestamp: Date.now() }],
    tools: [weather],
  }, { maxTokens: 500 });
  if (final?.stopReason === "error" && isSkipable(final)) {
    throw new Error(errorText(final));
  }
  const call = (final?.content ?? []).find((b: any) => b.type === "toolCall");
  if (!call || final?.stopReason !== "toolUse") {
    console.log(`      model=${m.id} stopReason=${final?.stopReason} call=${call ? call.name : "none"}`);
    return false;
  }
  console.log(`      model=${m.id} call=${call.name}(${JSON.stringify(call.arguments)})`);
  if (!call) return false;
  // Multi-turn: replay assistant toolCall + tool result, expect final answer.
  console.log("      -- follow-up turn with tool result --");
  const { final: final2 } = await run(model, {
    systemPrompt: "You are terse.",
    messages: [
      { role: "user", content: "What's the weather in Lisbon?", timestamp: Date.now() },
      final,
      {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: "18°C, light rain" }],
        isError: false,
        timestamp: Date.now(),
      },
    ],
    tools: [weather],
  }, { maxTokens: 300 });
  return final2?.stopReason === "stop" && /rain|18/i.test(textOf(final2));
});

// Models routed via @ai-sdk/openai (e.g. muse-spark) only answer on Zen's
// Responses endpoint — exercises the zen openai-responses engine adapter.
const responsesModels = models.filter(m => m.api === "openai-responses");
console.log("\n== 5. Responses-API models via zen engine ==");
await runModelProbe("responses completion", responsesModels, async (m) => {
  const { final } = await run(toPiModel(m), {
    systemPrompt: "You are terse.",
    messages: [{ role: "user", content: "Reply with exactly: RESPONSES_OK", timestamp: Date.now() }],
  }, { maxTokens: 200 });
  if (final?.stopReason === "error" && isSkipable(final)) {
    throw new Error(errorText(final));
  }
  return final?.stopReason === "stop" && /RESPONSES_OK/i.test(textOf(final));
});

console.log(`\n${failures === 0 ? "ALL REAL-SCENARIO CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
