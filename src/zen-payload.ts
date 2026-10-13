// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Zen public-lane payload shaping.
 *
 * OpenCode's shared `public` credential accepts only agent-shaped requests for
 * free models: streaming enabled plus the five core coding tools present.
 * This module appends the minimal missing structure per native backend.
 */

const CORE_TOOL_NAMES = ["bash", "edit", "glob", "grep", "read"] as const;

type JsonPrimitive = string | number | boolean | null;
interface JsonObject {
  [key: string]: JsonValue | undefined;
}
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type ZenPayload = JsonValue | undefined;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dummyToolDescription(name: string): string {
  return `OpenCode gateway compliance placeholder for ${name}. Do not call this tool.`;
}

function baseToolParameters(): JsonObject {
  return { type: "object", properties: {} };
}

function openAIChatTool(name: string): JsonObject {
  return {
    type: "function",
    function: {
      name,
      description: dummyToolDescription(name),
      parameters: baseToolParameters(),
    },
  };
}

function openAIResponsesTool(name: string): JsonObject {
  return {
    type: "function",
    name,
    description: dummyToolDescription(name),
    parameters: baseToolParameters(),
  };
}

function anthropicTool(name: string): JsonObject {
  return {
    name,
    description: dummyToolDescription(name),
    input_schema: baseToolParameters(),
  };
}

function googleFunctionDeclaration(name: string): JsonObject {
  return {
    name,
    description: dummyToolDescription(name),
    parametersJsonSchema: baseToolParameters(),
  };
}

function ensureStream(payload: JsonObject): boolean {
  if (payload.stream === true) return false;
  payload.stream = true;
  return true;
}

function ensureChatStreamUsage(payload: JsonObject): boolean {
  const current = payload.stream_options;
  if (!isRecord(current)) {
    payload.stream_options = { include_usage: true };
    return true;
  }
  if (current.include_usage === true) return false;
  payload.stream_options = { ...current, include_usage: true };
  return true;
}

function ensureTools(
  payload: JsonObject,
  getName: (item: unknown) => string | undefined,
  build: (name: string) => JsonObject,
): boolean {
  const current = payload.tools;
  if (current === undefined) {
    payload.tools = CORE_TOOL_NAMES.map(build);
    return true;
  }
  if (!Array.isArray(current)) return false;
  const present = new Set(
    current
      .map((item) => getName(item))
      .filter((name): name is string => typeof name === "string" && !!name),
  );
  const missing = CORE_TOOL_NAMES.filter((name) => !present.has(name));
  if (missing.length === 0) return false;
  payload.tools = [...current, ...missing.map(build)];
  return true;
}

function openAIChatToolName(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  const fn = item.function;
  if (isRecord(fn) && typeof fn.name === "string") return fn.name;
  const custom = item.custom;
  if (isRecord(custom) && typeof custom.name === "string") return custom.name;
  if (typeof item.name === "string") return item.name;
  return undefined;
}

function namedTool(item: unknown): string | undefined {
  return isRecord(item) && typeof item.name === "string" ? item.name : undefined;
}

function googleDeclaredToolNames(groups: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(groups)) return names;
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.functionDeclarations)) continue;
    for (const decl of group.functionDeclarations) {
      if (isRecord(decl) && typeof decl.name === "string") names.add(decl.name);
    }
  }
  return names;
}

function shapeOpenAICompletionsPayload(payload: JsonObject): JsonObject {
  ensureStream(payload);
  ensureChatStreamUsage(payload);
  ensureTools(payload, openAIChatToolName, openAIChatTool);
  return payload;
}

function shapeOpenAIResponsesPayload(payload: JsonObject): JsonObject {
  ensureStream(payload);
  ensureTools(payload, namedTool, openAIResponsesTool);
  return payload;
}

function shapeAnthropicPayload(payload: JsonObject): JsonObject {
  ensureStream(payload);
  ensureTools(payload, namedTool, anthropicTool);
  return payload;
}

function shapeGooglePayload(payload: JsonObject): JsonObject {
  const config = isRecord(payload.config) ? { ...payload.config } : {};
  const present = googleDeclaredToolNames(config.tools);
  const missing = CORE_TOOL_NAMES.filter((name) => !present.has(name));
  if (missing.length === 0) {
    if (!isRecord(payload.config)) payload.config = config;
    return payload;
  }
  const groups = Array.isArray(config.tools) ? [...config.tools] : [];
  const missingDecls = missing.map(googleFunctionDeclaration);
  const existingGroupIndex = groups.findIndex(
    (group) => isRecord(group) && Array.isArray(group.functionDeclarations),
  );
  if (existingGroupIndex >= 0) {
    const existingGroup = groups[existingGroupIndex] as JsonObject;
    const existingDecls = Array.isArray(existingGroup.functionDeclarations)
      ? existingGroup.functionDeclarations
      : [];
    groups[existingGroupIndex] = {
      ...existingGroup,
      functionDeclarations: [...existingDecls, ...missingDecls],
    };
  } else {
    groups.push({ functionDeclarations: missingDecls });
  }
  payload.config = { ...config, tools: groups };
  return payload;
}

/**
 * Returns a shaped payload copy for Zen's public lane. Unknown payload shapes
 * are passed through unchanged so paid/private behavior is never widened by
 * accident.
 */
export function applyOpenCodeFreePayload(
  payload: unknown,
  api: string,
): ZenPayload {
  if (!isRecord(payload)) return payload as ZenPayload;
  const shaped: JsonObject = { ...payload };
  const normalizedApi = api.replace(/^zen-/, "");
  switch (normalizedApi) {
    case "openai-completions":
      return shapeOpenAICompletionsPayload(shaped);
    case "openai-responses":
      return shapeOpenAIResponsesPayload(shaped);
    case "anthropic-messages":
      return shapeAnthropicPayload(shaped);
    case "google-generative-ai":
      return shapeGooglePayload(shaped);
    default:
      return payload as ZenPayload;
  }
}
