// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Extracts genuine OpenCode tool definitions directly from official releases
 * of https://github.com/anomalyco/opencode.
 *
 * How it works:
 * 1. Resolves the target release tag (latest stable vX.Y.Z or --tag).
 * 2. Downloads and unpacks the official OpenCode single-binary release asset
 *    for the current platform (or --bin).
 * 3. Starts an ephemeral in-memory mock OpenAI-compatible server on 127.0.0.1:0.
 * 4. Runs `opencode run --standalone` in a clean temporary sandbox:
 *    - once with a generic model (`mock/m`) to capture standard core tools;
 *    - once with `mock/gpt-5` to capture `patch` (which OpenCode activates for
 *      gpt-* models while omitting edit/write).
 * 5. Collects the union of all genuine tool definitions emitted by OpenCode's
 *    own runtime, preserving their exact descriptions and JSON-schemas.
 * 6. Verifies that all expected tools are present and formats the catalog
 *    into `src/opencode-tools.json` (or checks for drift under --check).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadReleaseBinary,
  resolveLatestReleaseTag,
  setupSandbox,
} from "./lib/opencode-release.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const TARGET_FILE = join(REPO_ROOT, "src", "opencode-tools.json");

export const CORE_EXPECTED_TOOLS = [
  "edit",
  "execute",
  "glob",
  "grep",
  "patch",
  "question",
  "read",
  "shell",
  "skill",
  "subagent",
  "webfetch",
  "websearch",
  "write",
] as const;

interface ToolDefinition {
  description: string;
  parameters: Record<string, unknown>;
}

interface CapturedToolCall {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

interface CapturedBody {
  model?: string;
  tools?: CapturedToolCall[];
}

interface ExtractorResult {
  tag: string;
  catalog: Record<string, ToolDefinition>;
  json: string;
}

async function runExtraction(opencodeBin: string, tag: string, baseDir: string): Promise<ExtractorResult> {
  const capturedBodies: CapturedBody[] = [];
  const enc = new TextEncoder();

  // Ephemeral in-memory mock OpenAI-compatible completion server
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const bodyText = await req.text();
      try {
        const parsed = JSON.parse(bodyText) as CapturedBody;
        if (parsed && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
          capturedBodies.push(parsed);
        }
        const model = parsed.model ?? "mock";
        const payload = {
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        };
        const s = new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));
            c.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ ...payload, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
              ),
            );
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          },
        });
        return new Response(s, {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      } catch {
        return new Response("ok");
      }
    },
  });

  const { sandboxDir, runEnv } = setupSandbox(baseDir, server.port);

  try {
    // 1. Run standard model: captures 12 default tools (edit, write, shell, glob, grep, etc.)
    const proc1 = Bun.spawn(
      [opencodeBin, "run", "--standalone", "--log-level", "error", "-m", "mock/m", "extract"],
      {
        env: runEnv,
        cwd: sandboxDir,
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const code1 = await proc1.exited;
    if (code1 !== 0) {
      throw new Error(`opencode run (mock/m) failed with exit code ${code1}`);
    }

    // 2. Run gpt-5 model: captures patch (replaces edit/write in OpenCode runtime for gpt-* models)
    const proc2 = Bun.spawn(
      [opencodeBin, "run", "--standalone", "--log-level", "error", "-m", "mock/gpt-5", "extract"],
      {
        env: runEnv,
        cwd: sandboxDir,
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const code2 = await proc2.exited;
    if (code2 !== 0) {
      throw new Error(`opencode run (mock/gpt-5) failed with exit code ${code2}`);
    }
  } finally {
    server.stop(true);
  }

  // Aggregate definitions from captured bodies
  const rawCatalog: Record<string, ToolDefinition> = {};
  for (const body of capturedBodies) {
    if (!Array.isArray(body.tools)) continue;
    for (const item of body.tools) {
      const f = item.function;
      if (f && f.name && !rawCatalog[f.name]) {
        rawCatalog[f.name] = {
          description: f.description,
          parameters: f.parameters,
        };
      }
    }
  }

  // Validate that all expected core tools are present
  const missing = CORE_EXPECTED_TOOLS.filter((name) => !rawCatalog[name]);
  if (missing.length > 0) {
    throw new Error(
      `OpenCode run did not emit all expected tools. Missing: ${missing.join(", ")}. Emitted: ${Object.keys(rawCatalog).join(", ")}`,
    );
  }

  // Sort tools alphabetically for deterministic output
  const sortedCatalog: Record<string, ToolDefinition> = {};
  const allNames = Array.from(new Set([...Object.keys(rawCatalog), ...CORE_EXPECTED_TOOLS])).sort();
  for (const name of allNames) {
    sortedCatalog[name] = rawCatalog[name];
  }

  // Canonical catalog serialization: JSON with 1-space indentation, no trailing newline
  const json = JSON.stringify(sortedCatalog, null, 1);

  return {
    tag,
    catalog: sortedCatalog,
    json,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const isWrite = args.includes("--write") || !isCheck;

  let customTag: string | undefined;
  const tagIdx = args.indexOf("--tag");
  if (tagIdx !== -1 && args[tagIdx + 1]) {
    customTag = args[tagIdx + 1];
  }

  let customBin: string | undefined;
  const binIdx = args.indexOf("--bin");
  if (binIdx !== -1 && args[binIdx + 1]) {
    customBin = args[binIdx + 1];
  }

  const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  console.log("Resolving OpenCode release...");
  const tag = customTag ?? (await resolveLatestReleaseTag(githubToken));
  console.log(`Using release tag: ${tag}`);

  const workDir = join("/tmp", "pi", "extract-tools", tag);
  let opencodeBin = customBin;

  if (!opencodeBin) {
    opencodeBin = await downloadReleaseBinary(tag, join(workDir, "bin"));
  }
  console.log(`OpenCode binary: ${opencodeBin}`);

  console.log("Extracting tool definitions via standalone runtime snapshot...");
  const result = await runExtraction(opencodeBin, tag, workDir);
  const toolNames = Object.keys(result.catalog);
  console.log(`Successfully extracted ${toolNames.length} tools: ${toolNames.join(", ")}`);

  let currentJson = "";
  if (existsSync(TARGET_FILE)) {
    currentJson = readFileSync(TARGET_FILE, "utf8");
  }

  const hasDiff = currentJson !== result.json;

  if (isCheck) {
    if (hasDiff) {
      console.error("\n[DRIFT DETECTED] src/opencode-tools.json differs from official release " + tag);
      console.error("Run `bun run extract-tools` to update the catalog.");
      process.exit(1);
    } else {
      console.log("\n[OK] src/opencode-tools.json is up-to-date with " + tag);
      process.exit(0);
    }
  }

  if (isWrite) {
    if (!hasDiff) {
      console.log(`\nsrc/opencode-tools.json is already identical to release ${tag}.`);
    } else {
      writeFileSync(TARGET_FILE, result.json, "utf8");
      console.log(`\nUpdated src/opencode-tools.json from release ${tag}.`);
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Extraction error:", err);
    process.exit(1);
  });
}
