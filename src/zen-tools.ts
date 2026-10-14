// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Zen public-lane request shaping: the genuine OpenCode tool definitions,
 * applied at the engine-agnostic context level.
 *
 * Since 2026-10-14 the free tier validates the shape of every tool it
 * recognises — a stub that reuses the name (wrong description and/or
 * parameter schema) is rejected with 403 FreeTierError — and requests
 * without a shell tool and a read tool are rejected outright. pi-ai exposes
 * no payload transform (only `transformHeaders`), so the `zen-*` engine
 * adapters shape `context.tools` before delegating to their native engine:
 * the native engine renders those tools into whatever wire format its
 * backend expects, from the exact same source definitions.
 *
 * Definitions are the genuine OpenCode ones captured from the official CLI
 * (byte-equality is what the gate checks), kept in `./opencode-tools.json`.
 * Tool order is irrelevant and extra client tools are allowed.
 */
import type { Context, Tool } from "@earendil-works/pi-ai";
import definitions from "./opencode-tools.json" with { type: "json" };

interface OpenCodeToolDefinition {
  description: string;
  parameters: Record<string, unknown>;
}

/** Genuine OpenCode definitions (description + JSON-schema parameters). */
export const OPENCODE_TOOL_DEFINITIONS: Record<
  string,
  OpenCodeToolDefinition
> = definitions as Record<string, OpenCodeToolDefinition>;

/**
 * The core agent toolset the free tier expects to be present (names matter
 * only for its presence check; the definitions stay genuine). "shell" is the
 * OpenCode 2.x name — "bash" is deliberately not injected because it is a
 * recognised name the captured set has no definition for.
 */
export const OPENCODE_CORE_TOOL_NAMES = [
  "shell",
  "edit",
  "glob",
  "grep",
  "read",
] as const;

/** Returns true for a tool name whose genuine OpenCode definition is known. */
export function isKnownOpencodeToolName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(OPENCODE_TOOL_DEFINITIONS, name);
}

/** Builds the genuine definition as a pi-ai Tool. */
export function opencodeTool(name: string): Tool {
  const definition = OPENCODE_TOOL_DEFINITIONS[name];
  if (!definition) throw new Error(`No genuine OpenCode definition: ${name}`);
  return {
    name,
    description: definition.description,
    // Cast: TSchema is JSON-schema-by-structurally-unverified; the captured
    // parameters are the genuine schema the gate compares against.
    parameters: definition.parameters as Tool["parameters"],
  };
}

/**
 * Returns true when the item already carries the genuine definition. The
 * description is the integrity marker: shaping is idempotent and a client
 * that re-declares a genuine-shaped tool is left untouched.
 */
function isGenuineTool(item: unknown): boolean {
  return (
    typeof item === "object" &&
    item !== null &&
    (item as Tool).description ===
      OPENCODE_TOOL_DEFINITIONS[(item as Tool).name]?.description
  );
}

function toolName(item: unknown): string | undefined {
  return typeof item === "object" &&
    item !== null &&
    typeof (item as Tool).name === "string"
    ? (item as Tool).name
    : undefined;
}

/**
 * Shapes a request context for the free tier: every recognised tool name
 * carries the genuine definition (a downstream-declared same-named tool
 * would otherwise fail the definition check), and any missing core tools
 * are appended. Returns the context unchanged when nothing is missing and
 * nothing was rewritten, so plain paid/unknown behavior is never widened.
 */
export function applyOpenCodeFreeTools(context: Context): Context {
  const tools = context.tools;
  if (tools === undefined) {
    return {
      ...context,
      tools: OPENCODE_CORE_TOOL_NAMES.map(opencodeTool),
    };
  }
  if (!Array.isArray(tools)) return context;
  const shaped: Tool[] = [];
  let changed = false;
  for (const item of tools) {
    const name = toolName(item);
    if (
      typeof name === "string" &&
      isKnownOpencodeToolName(name) &&
      !isGenuineTool(item)
    ) {
      shaped.push(opencodeTool(name));
      changed = true;
      continue;
    }
    shaped.push(item);
  }
  const present = new Set(shaped.map((tool) => tool.name));
  const missing = OPENCODE_CORE_TOOL_NAMES.filter(
    (name) => !present.has(name),
  );
  if (missing.length > 0) {
    shaped.push(...missing.map(opencodeTool));
    changed = true;
  }
  if (!changed) return context;
  return { ...context, tools: shaped };
}
