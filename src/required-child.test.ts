// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  REQUIRED_CHILD_EXTENSION_ID,
  hookRequiredChildExtension,
  resolveSelfEntryPath,
  resolveSessionKeys,
} from "./required-child.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

type Handler = (event: unknown, ctx: unknown) => void;

function makeFakePi() {
  const handlers = new Map<string, Handler[]>();
  const fakePi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
  } as unknown as ExtensionAPI;
  return { fakePi, handlers };
}

test("resolveSelfEntryPath points at an existing entry file", () => {
  const path = resolveSelfEntryPath();
  assert.ok(path, "expected an entry path in src or dist layout");
  assert.match(path!, /index\.(js|ts)$/);
});

test("resolveSessionKeys prefers the bare id, file as secondary", () => {
  assert.deepEqual(
    resolveSessionKeys({
      sessionManager: {
        getSessionFile: () => "/tmp/session.jsonl",
        getSessionId: () => "abc",
      },
    }),
    { primary: "abc", secondary: "/tmp/session.jsonl" },
  );
  assert.deepEqual(
    resolveSessionKeys({ sessionManager: { getSessionId: () => "abc" } }),
    { primary: "abc" },
  );
  assert.deepEqual(
    resolveSessionKeys({
      sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
    }),
    { primary: "/tmp/session.jsonl" },
  );
  assert.deepEqual(resolveSessionKeys(undefined), {});
  assert.deepEqual(
    resolveSessionKeys({
      sessionManager: {
        getSessionFile: () => "  ",
        getSessionId: () => "",
      },
    }),
    {},
  );
});

test("hook registers under both id and file keys on session_start", async () => {
  const { fakePi, handlers } = makeFakePi();
  const seen: { sessionId: string; extensions: { id: string; path: string }[] }[] =
    [];
  let disposed = 0;
  hookRequiredChildExtension(fakePi, {
    selfPath: "/tmp/pi-opencode-free-entry.ts",
    importRegister: async () => (input) => {
      seen.push(input);
      return {
        dispose() {
          disposed++;
        },
      };
    },
  });
  const starts = handlers.get("session_start") ?? [];
  starts[0]!(
    { type: "session_start", reason: "startup" },
    {
      sessionManager: {
        getSessionFile: () => "/tmp/session.jsonl",
        getSessionId: () => "parent-session",
      },
    },
  );
  await tick();
  await tick();
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.sessionId, "parent-session"); // bare id first: child lookup key
  assert.equal(seen[1]!.sessionId, "/tmp/session.jsonl");
  for (const entry of seen) {
    assert.deepEqual(entry.extensions, [
      {
        id: REQUIRED_CHILD_EXTENSION_ID,
        path: "/tmp/pi-opencode-free-entry.ts",
      },
    ]);
  }
  const shutdowns = handlers.get("session_shutdown") ?? [];
  assert.equal(shutdowns.length, 1);
  shutdowns[0]!({ type: "session_shutdown" }, {});
  assert.equal(disposed, 2);
});

test("hook tolerates duplicate session_start and missing peer", async () => {
  const { fakePi, handlers } = makeFakePi();
  let calls = 0;
  hookRequiredChildExtension(fakePi, {
    sessionId: "s",
    selfPath: "/tmp/entry.ts",
    importRegister: async () => () => {
      calls++;
      throw new Error("Required child extensions are already registered");
    },
  });
  const starts = handlers.get("session_start") ?? [];
  starts[0]!({ type: "session_start" }, {});
  await tick();
  await tick();
  assert.equal(calls, 1); // duplicate registration swallowed, parent unaffected

  const { fakePi: pi2, handlers: h2 } = makeFakePi();
  hookRequiredChildExtension(pi2, {
    sessionId: "s",
    selfPath: "/tmp/entry.ts",
    importRegister: async () => undefined, // pi-subagents not installed
  });
  const starts2 = h2.get("session_start") ?? [];
  starts2[0]!({ type: "session_start" }, {});
  await tick();
  await tick();
  // No throw, no registration — parent session keeps working.
});
