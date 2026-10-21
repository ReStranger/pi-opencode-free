// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOpenCodeFreeTools,
  isKnownOpencodeToolName,
  opencodeTool,
  OPENCODE_CORE_TOOL_NAMES,
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
