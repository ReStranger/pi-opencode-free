// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import {
  applyOpenCodeFreeContext,
  applyOpenCodeFreeSystemPrompt,
  applyOpenCodeFreeTools,
  isKnownOpencodeToolName,
  opencodeTool,
  OPENCODE_CORE_TOOL_NAMES,
  OPENCODE_ENV_BLOCK,
  OPENCODE_TOOL_DEFINITIONS,
} from "#src/zen-tools.ts";

test("genuine definitions cover the core toolset and are substantive", () => {
  for (const name of OPENCODE_CORE_TOOL_NAMES) {
    const definition = OPENCODE_TOOL_DEFINITIONS[name];
    assert.ok(definition, `definition exists for core tool ${name}`);
    assert.ok(
      definition.description.length > 20,
      `core tool ${name} has a real description`,
    );
    assert.ok(
      definition.parameters &&
        (definition.parameters as Record<string, unknown>).type === "object",
      `core tool ${name} has an object parameter schema`,
    );
  }
  // "shell" is the OpenCode 2.x name; "bash" ships no genuine definition.
  assert.ok(isKnownOpencodeToolName("shell"));
  assert.equal(isKnownOpencodeToolName("bash"), false);
});

test("applyOpenCodeFreeTools injects the core toolset when tools are absent", () => {
  const shaped = applyOpenCodeFreeTools({
    messages: [],
    systemPrompt: "You are terse.",
  });
  const names = shaped.tools!.map((tool) => tool.name);
  for (const name of OPENCODE_CORE_TOOL_NAMES) {
    assert.ok(names.includes(name), `core tool ${name} injected`);
  }
  // The genuine definition rides the injected tool.
  assert.equal(
    shaped.tools!.find((tool) => tool.name === "shell")!.description,
    OPENCODE_TOOL_DEFINITIONS.shell!.description,
  );
});

test("applyOpenCodeFreeTools rewrites same-named tools with the genuine definition", () => {
  const shaped = applyOpenCodeFreeTools({
    messages: [],
    tools: [
      opencodeStub("read", "my own reader"),
      {
        name: "get_weather",
        description: "Weather lookup",
        parameters: { type: "object", properties: {} },
      },
    ],
  });
  const byName = new Map(shaped.tools!.map((tool) => [tool.name, tool]));
  assert.notEqual(
    byName.get("read")!.description,
    "my own reader",
    "recognised name must keep the genuine definition, not the stub",
  );
  assert.equal(
    byName.get("read")!.description,
    OPENCODE_TOOL_DEFINITIONS.read!.description,
  );
  assert.equal(
    // eslint-disable-next-line
    byName.get("get_weather")!.description,
    "Weather lookup",
    "unknown names pass through untouched (downstream function calling)",
  );
});

test("applyOpenCodeFreeTools keeps unrelated context fields and is idempotent", () => {
  const base: any = {
    systemPrompt: "s",
    messages: [{ role: "user", content: "hi" }],
    tools: [opencodeStub("shell", "custom shell")],
  };
  const once = applyOpenCodeFreeTools(base);
  const twice = applyOpenCodeFreeTools(once);
  assert.equal(once.systemPrompt, "s");
  assert.deepEqual(once.messages, base.messages);
  assert.deepEqual(twice.tools, once.tools, "shaping twice changes nothing");
});

test("applyOpenCodeFreeTools leaves a fully genuine context unchanged", () => {
  const context: any = {
    messages: [],
    tools: OPENCODE_CORE_TOOL_NAMES.map(opencodeTool),
  };
  assert.equal(applyOpenCodeFreeTools(context), context); // identity: nothing changed
});

test("applyOpenCodeFreeTools injects genuine tools into leading system message (compaction request)", () => {
  // Compaction requests build an isolated TranscriptContext: a system message
  // with no toolsAdded and no top-level tools.
  const compactionContext: any = {
    messages: [
      {
        role: "system",
        content: "You are a context summarization assistant.",
        timestamp: 0,
      },
      {
        role: "user",
        content: [{ type: "text", text: "Summarize this." }],
        timestamp: 1,
      },
    ],
  };
  const shaped: any = applyOpenCodeFreeTools(compactionContext);
  const first = shaped.messages?.[0];
  assert.ok(first?.toolsAdded, "toolsAdded must be populated on system message");
  const names = (first.toolsAdded as any[]).map((t) => t.name);
  for (const name of OPENCODE_CORE_TOOL_NAMES) {
    assert.ok(names.includes(name), `system message toolsAdded includes ${name}`);
  }
  // tools array on context is also shaped for compatibility
  assert.ok(Array.isArray(shaped.tools));
});

test("applyOpenCodeFreeTools rewrites stubs inside leading system message toolsAdded", () => {
  const context: any = {
    messages: [
      {
        role: "system",
        content: "You are helpful.",
        toolsAdded: [opencodeStub("shell", "fake shell")],
        timestamp: 0,
      },
      {
        role: "user",
        content: "hi",
        timestamp: 1,
      },
    ],
  };
  const shaped: any = applyOpenCodeFreeTools(context);
  const first = shaped.messages?.[0];
  const shell = (first?.toolsAdded as any[] | undefined)?.find(
    (t) => t.name === "shell",
  );
  assert.equal(
    shell?.description,
    OPENCODE_TOOL_DEFINITIONS.shell!.description,
    "stub inside system message toolsAdded must be replaced with genuine definition",
  );
});

test("the v2 catalog covers `patch` without adding it to the core toolset", () => {
  // opencode2api f0f064f: the v2 gateway catalog gained a `patch` entry.
  assert.ok(isKnownOpencodeToolName("patch"));
  // It is a client-side tool, never injected: the core toolset stays five.
  assert.equal((OPENCODE_CORE_TOOL_NAMES as readonly string[]).includes("patch"), false);
  const shaped = applyOpenCodeFreeTools({
    messages: [],
    tools: [opencodeStub("patch", "mine")],
  });
  const patch = shaped.tools!.find((tool) => tool.name === "patch")!;
  assert.notEqual(patch.description, "mine");
  assert.equal(patch.description, OPENCODE_TOOL_DEFINITIONS.patch!.description);
  assert.deepEqual(patch.parameters, OPENCODE_TOOL_DEFINITIONS.patch!.parameters);
  // The entry is the fingerprinted upstream text (non-breaking U+2011 hyphens).
  assert.ok(OPENCODE_TOOL_DEFINITIONS.patch!.description.includes("stripped\u2011down"));
});

/** Minimal client-declared tool used to exercise the rewrite path. */
function opencodeStub(
  name: string,
  description: string,
): ReturnType<typeof opencodeTool> {
  return {
    name,
    description,
    parameters: { type: "object", properties: {} } as never,
  };
}

test("system-prompt shaping appends the <env> marker the gate requires", () => {
  const context: Context = {
    systemPrompt: "You are terse.",
    messages: [],
  };
  const shaped = applyOpenCodeFreeSystemPrompt(context);
  assert.notEqual(shaped, context);
  assert.ok(shaped.systemPrompt?.startsWith("You are terse."));
  assert.ok(shaped.systemPrompt?.includes("<env>"));
  assert.ok(shaped.systemPrompt?.includes("</env>"));
  assert.ok(shaped.systemPrompt?.includes(OPENCODE_ENV_BLOCK));
});

test("system-prompt shaping adds the marker when no prompt is present", () => {
  const shaped = applyOpenCodeFreeSystemPrompt({ messages: [] });
  assert.equal(shaped.systemPrompt, OPENCODE_ENV_BLOCK);
  assert.match(shaped.systemPrompt ?? "", /<env>[\s\S]*<\/env>/);
});

test("system-prompt shaping does not duplicate an existing <env> block", () => {
  const context: Context = {
    systemPrompt: "prompt\n\n<env>\n</env>",
    messages: [],
  };
  assert.equal(applyOpenCodeFreeSystemPrompt(context), context);
});

test("system-prompt shaping marks the leading transcript system message", () => {
  // Pi 1.0+ native engines take the wire system prompt from this transcript
  // entry, not from `context.systemPrompt`; an empty content is the Pi 1.4
  // shape where the real prompt is rendered by the host around it.
  const context = {
    messages: [
      { role: "system", content: "" },
      { role: "user", content: "hi", timestamp: 1 },
    ],
  } as unknown as Context;
  const shaped = applyOpenCodeFreeSystemPrompt(context);
  const first = shaped.messages[0] as unknown as {
    role: string;
    content: string;
  };
  assert.equal(first.role, "system");
  assert.match(first.content, /<env>[\s\S]*<\/env>/);
  assert.equal(shaped.messages[1], context.messages[1]);
  assert.equal(shaped.systemPrompt, undefined); // transcript carries the marker
});

test("full context shaping adds tools and the marker without losing messages", () => {
  const messages: Context["messages"] = [
    { role: "user", content: "hi", timestamp: 1 },
  ];
  const shaped = applyOpenCodeFreeContext({
    systemPrompt: "You are terse.",
    messages,
  });
  assert.equal(shaped.messages, messages);
  assert.match(shaped.systemPrompt ?? "", /<env>[\s\S]*<\/env>/);
  assert.ok(Array.isArray(shaped.tools));
  assert.ok(shaped.tools?.some((tool) => tool.name === "shell"));
  assert.ok(shaped.tools?.some((tool) => tool.name === "read"));
});
