// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Zen public-lane request shaping: the genuine OpenCode tool definitions and
 * the `<env>` system-prompt marker, applied at the engine-agnostic context
 * level.
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
 * The same gate also rejects a system prompt without a literal `<env>`
 * block with 429 FreeUsageLimitError (the official client always includes
 * one; Pi renders `<cwd>`/`<mcp_servers>` instead). `applyOpenCodeFreeContext`
 * appends a small real environment block when the tag is absent.
 *
 * Definitions are the genuine OpenCode ones captured from the official CLI
 * (byte-equality is what the gate checks), kept in `./opencode-tools.json`.
 * Tool order is irrelevant and extra client tools are allowed.
 */
import type { Context, Tool } from "@earendil-works/pi-ai";
import definitions from "#src/opencode-tools.json" with { type: "json" };

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
 * Normalizes a list of tools for the free tier: every recognised tool name
 * carries the genuine definition, and any missing core tools are appended.
 */
function shapeToolList(tools?: readonly unknown[]): {
  shaped: Tool[];
  changed: boolean;
} {
  const list = Array.isArray(tools) ? tools : [];
  const shaped: Tool[] = [];
  let changed = !Array.isArray(tools);
  for (const item of list) {
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
    if (item && typeof item === "object") {
      shaped.push(item as Tool);
    }
  }
  const present = new Set(shaped.map((tool) => tool.name));
  const missing = OPENCODE_CORE_TOOL_NAMES.filter((name) => !present.has(name));
  if (missing.length > 0) {
    shaped.push(...missing.map(opencodeTool));
    changed = true;
  }
  return { shaped, changed };
}

/**
 * Shapes a request context for the free tier: every recognised tool name
 * carries the genuine definition (a downstream-declared same-named tool
 * would otherwise fail the definition check), and any missing core tools
 * are appended.
 *
 * In Pi 1.0+, native engines resolve tools from the transcript system
 * messages (`context.messages[0].toolsAdded` via `resolveTranscriptTools`),
 * while legacy callers and unit tests inspect top-level `context.tools`.
 * This helper shapes BOTH:
 * - `context.tools` is populated with genuine core tools.
 * - If `context.messages` has a leading system message (including the
 *   isolated summarization request built by Pi core during /compaction),
 *   its `toolsAdded` is populated with the shaped core tools.
 * - If `context.messages` has no leading system message, one is prepended.
 *
 * Returns the context unchanged when nothing is missing and nothing was
 * rewritten, so plain paid/unknown behavior is never widened.
 */
export function applyOpenCodeFreeTools(context: Context): Context {
  const { shaped: shapedTools, changed: toolsChanged } = shapeToolList(
    context.tools,
  );

  let messages = context.messages;
  let messagesChanged = false;

  if (Array.isArray(messages) && messages.length > 0) {
    const first: unknown = messages[0];
    const isObject = typeof first === "object" && first !== null;
    const isSystemRole =
      isObject && (first as { role?: unknown }).role === "system";
    if (isSystemRole) {
      // SAFETY: isSystemRole verified first is an object message.
      const sysObj = first as Record<string, unknown>;
      const existing = sysObj.toolsAdded as unknown[] | undefined;
      const baseForSystem = existing ?? context.tools;
      const { shaped: systemTools, changed: systemChanged } =
        shapeToolList(baseForSystem);
      if (systemChanged || !existing) {
        // SAFETY: SystemMessage with toolsAdded is a valid transcript entry in pi-ai.
        const updated = {
          ...sysObj,
          toolsAdded: systemTools,
        } as unknown as (typeof messages)[number];
        messages = [updated, ...messages.slice(1)];
        messagesChanged = true;
      }
    }
  }

  if (!toolsChanged && !messagesChanged) return context;
  return {
    ...context,
    tools: shapedTools,
    ...(messages ? { messages } : {}),
  };
}

/** The literal tag pair the free-tier gate looks for in the system prompt. */
export const OPENCODE_ENV_BLOCK = `<env>
  Working directory: ${process.cwd()}
  Platform: ${process.platform}
</env>`;

/**
 * Appends the free tier's `<env>` marker when the system prompt has none.
 *
 * The gate accepts any `<env>...</env>` block (values are not validated), so
 * a small real block is used instead of impersonating the official client's
 * full environment dump. Prompts that already carry the tag are returned
 * unchanged to avoid duplicating it on engines that round-trip the prompt.
 *
 * Pi 1.0+ native engines derive the wire system prompt from the leading
 * transcript system message (`context.messages[0].content`) and overwrite
 * `context.systemPrompt` with it. The transcript entry therefore takes
 * precedence when present; `context.systemPrompt` is shaped for legacy
 * callers and direct engine tests.
 */
export function applyOpenCodeFreeSystemPrompt(context: Context): Context {
  const systemPrompt = context.systemPrompt;
  const messages = context.messages;
  const first: unknown =
    Array.isArray(messages) && messages.length > 0 ? messages[0] : undefined;
  const firstObj =
    typeof first === "object" && first !== null
      ? (first as Record<string, unknown>)
      : undefined;
  const isTranscriptSystem =
    firstObj !== undefined && firstObj.role === "system";
  const transcript =
    isTranscriptSystem && typeof firstObj.content === "string"
      ? firstObj.content
      : undefined;

  // Pi 1.0+ renders the wire prompt from the transcript entry, so shaping it
  // is sufficient (and avoids a second marker when the host also forwards
  // `systemPrompt`).
  if (transcript !== undefined) {
    if (transcript.includes("<env>")) return context;
    const updated = {
      ...firstObj,
      content: `${transcript}\n\n${OPENCODE_ENV_BLOCK}`,
    };
    // SAFETY: the leading entry was verified to be a transcript system
    // message; pi-ai's Context type omits that internal Pi 1.0+ entry.
    return {
      ...context,
      messages: [
        updated as unknown as (typeof messages)[number],
        ...messages.slice(1),
      ],
    };
  }

  if (typeof systemPrompt === "string") {
    if (systemPrompt.includes("<env>")) return context;
    return {
      ...context,
      systemPrompt: `${systemPrompt}\n\n${OPENCODE_ENV_BLOCK}`,
    };
  }
  return { ...context, systemPrompt: OPENCODE_ENV_BLOCK };
}

/**
 * Applies every context-level free-tier shape: genuine tools plus the
 * `<env>` system-prompt marker. This is the single context transform the
 * `zen-*` adapters apply before delegating to a native engine.
 */
export function applyOpenCodeFreeContext(context: Context): Context {
  return applyOpenCodeFreeSystemPrompt(applyOpenCodeFreeTools(context));
}
