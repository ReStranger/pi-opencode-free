// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-scenario smoke test against the live OpenCode Zen API, exercising the
 * extension's exact provider config via the registered `zen-*` engine
 * adapters (the same stamping path every backend travels in production).
 * Run with: bun scripts/smoke-real.ts
 */
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type {
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
} from "../src/zen-headers.js";
import {
  nativeApiForZen,
  registerZenApiProviders,
  zenApiForNative,
  ZEN_COMPLETIONS_API,
} from "../src/zen-engines.js";

registerZenApiProviders();

// Mirrors src/index.ts COMPLETIONS_COMPAT (Zen free-tier quirks).
const OPENCODE_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsFinishReason: false,
  maxTokensField: "max_tokens" as const,
  requiresReasoningContentOnAssistantMessages: true,
};

const HEADERS = {
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
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
  applyOpenCodeFreeHeaders(headers);
  return engine.streamSimple(model, context, { ...options, headers });
}

function toPiModel(m: Awaited<ReturnType<typeof discoverModels>>[number]): any {
  // Mirrors src/index.ts toProviderModel: zen-* engine routing with
  // stock-style compat/baseUrl (completions quirks only apply to
  // openai-completions; Anthropic/Google engines get no compat).
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
        ? { sessionAffinityFormat: "openai-nosession" }
        : native === "openai-completions"
          ? OPENCODE_COMPAT
          : undefined,
    headers: HEADERS,
  };
}

async function run(model: Model, context: Context, opts?: any) {
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

console.log("== 1. Live model discovery from OpenCode Zen ==");
const models = await discoverModels();
console.log(`   endpoint lists ${models.length} free models (all served): ${models.map(m => m.id).join(", ")}`);
check("discovery returns free models", models.length > 0);
check(
  "all discovered ids match the free regex",
  models.every(m => /(^(opencode\/)?.*-free$)|(^(opencode\/)?big-pickle$)/i.test(m.id)),
);

const nonReasoning = models.find(m => !m.reasoning) ?? models[0];
console.log(`\n== 2. Plain chat via zen engine (${nonReasoning.id}) ==`);
{
  const { final } = await run(toPiModel(nonReasoning), {
    systemPrompt: "You are terse.",
    messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: Date.now() }],
  }, { maxTokens: 200 });
  const ok = final?.stopReason === "stop" && /OK/i.test(textOf(final));
  check("chat completion succeeds", ok, `stopReason=${final?.stopReason} text="${textOf(final).trim().slice(0, 60)}"`);
  check("usage reported", (final?.usage?.output ?? 0) > 0, JSON.stringify(final?.usage));
}

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

const toolModel = models.find(m => !m.reasoning) ?? models[0];
console.log(`\n== 4. Native tool calling (${toolModel.id}) ==`);
{
  const weather: Tool = {
    name: "get_weather",
    description: "Get current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  };
  const { final } = await run(toPiModel(toolModel), {
    systemPrompt: "You must use the get_weather tool to answer weather questions.",
    messages: [{ role: "user", content: "What's the weather in Lisbon?", timestamp: Date.now() }],
    tools: [weather],
  }, { maxTokens: 500 });
  const call = (final?.content ?? []).find((b: any) => b.type === "toolCall");
  check("tool call emitted", !!call, call ? `${call.name}(${JSON.stringify(call.arguments)})` : `stopReason=${final?.stopReason}`);
  check("stopReason is toolUse", final?.stopReason === "toolUse", `got ${final?.stopReason}`);

  if (call) {
    // Multi-turn: replay assistant toolCall + tool result, expect final answer.
    console.log("   -- follow-up turn with tool result --");
    const { final: final2 } = await run(toPiModel(toolModel), {
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
    check("post-tool answer succeeds", final2?.stopReason === "stop" && /rain|18/i.test(textOf(final2)), `stopReason=${final2?.stopReason} text="${textOf(final2).trim().slice(0, 60)}"`);
  }
}

// Models routed via @ai-sdk/openai (e.g. muse-spark) only answer on Zen's
// Responses endpoint — exercises the zen openai-responses engine adapter.
const responsesModel = models.find(m => m.api === "openai-responses");
if (responsesModel) {
  console.log(`\n== 5. Responses-API model via zen engine (${responsesModel.id}) ==`);
  const { final } = await run(toPiModel(responsesModel), {
    systemPrompt: "You are terse.",
    messages: [{ role: "user", content: "Reply with exactly: RESPONSES_OK", timestamp: Date.now() }],
  }, { maxTokens: 200 });
  check("responses completion succeeds", final?.stopReason === "stop", `stopReason=${final?.stopReason}`);
  check("responses answer present", /RESPONSES_OK/i.test(textOf(final)), `"${textOf(final).trim().slice(0, 60)}"`);
} else {
  console.log("\n== 5. Skipped: no @ai-sdk/openai-routed model in discovery ==");
}

console.log(`\n${failures === 0 ? "ALL REAL-SCENARIO CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
