// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Extracts the genuine OpenCode client User-Agent header directly from official
 * releases of https://github.com/anomalyco/opencode.
 *
 * How it works:
 * 1. Resolves the target release tag (latest stable vX.Y.Z or --tag).
 * 2. Downloads and unpacks the official OpenCode single-binary release asset
 *    for the current platform (or --bin).
 * 3. Starts an ephemeral in-memory mock server on 127.0.0.1:0.
 * 4. Runs `opencode run --standalone` in an isolated sandbox.
 * 5. Captures the wire `User-Agent` header sent by the official binary.
 * 6. Validates format (`opencode/<channel>/<version>/cli`) and updates
 *    `OPENCODE_USER_AGENT` in `src/zen-headers.ts` (or checks for drift under --check).
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
const TARGET_FILE = join(REPO_ROOT, "src", "zen-headers.ts");

const USER_AGENT_REGEX = /^opencode\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/cli$/;

async function runExtraction(opencodeBin: string, baseDir: string): Promise<string> {
  let capturedUserAgent: string | undefined;

  const enc = new TextEncoder();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const ua = req.headers.get("user-agent");
      if (ua) {
        capturedUserAgent = ua;
      }
      const payload = {
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "mock",
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
    },
  });

  const { sandboxDir, runEnv } = setupSandbox(baseDir, server.port);

  try {
    const proc = Bun.spawn(
      [opencodeBin, "run", "--standalone", "--log-level", "error", "-m", "mock/m", "extract"],
      {
        env: runEnv,
        cwd: sandboxDir,
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`opencode run failed with exit code ${code}`);
    }
  } finally {
    server.stop(true);
  }

  if (!capturedUserAgent) {
    throw new Error("No User-Agent header was captured from the OpenCode run");
  }

  if (!USER_AGENT_REGEX.test(capturedUserAgent)) {
    throw new Error(`Captured User-Agent does not match expected format: "${capturedUserAgent}"`);
  }

  return capturedUserAgent;
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

  console.log("Extracting User-Agent header via standalone runtime snapshot...");
  const capturedUserAgent = await runExtraction(opencodeBin, workDir);
  console.log(`Successfully captured User-Agent: "${capturedUserAgent}"`);

  if (!existsSync(TARGET_FILE)) {
    throw new Error(`Target file does not exist: ${TARGET_FILE}`);
  }

  const currentContent = readFileSync(TARGET_FILE, "utf8");
  const match = currentContent.match(/export const OPENCODE_USER_AGENT = "([^"]+)";/);
  if (!match) {
    throw new Error(`Could not find OPENCODE_USER_AGENT declaration in ${TARGET_FILE}`);
  }

  const currentUserAgent = match[1];
  const hasDiff = currentUserAgent !== capturedUserAgent;

  if (isCheck) {
    if (hasDiff) {
      console.error(`\n[DRIFT DETECTED] OPENCODE_USER_AGENT in src/zen-headers.ts is "${currentUserAgent}", but release ${tag} sends "${capturedUserAgent}"`);
      console.error("Run `bun run extract-user-agent` to update.");
      process.exit(1);
    } else {
      console.log(`\n[OK] OPENCODE_USER_AGENT is up-to-date with ${tag} ("${capturedUserAgent}")`);
      process.exit(0);
    }
  }

  if (isWrite) {
    if (!hasDiff) {
      console.log(`\nOPENCODE_USER_AGENT is already up-to-date ("${capturedUserAgent}").`);
    } else {
      const updatedContent = currentContent.replace(
        /export const OPENCODE_USER_AGENT = "[^"]+";/,
        `export const OPENCODE_USER_AGENT = "${capturedUserAgent}";`,
      );
      writeFileSync(TARGET_FILE, updatedContent, "utf8");
      console.log(`\nUpdated OPENCODE_USER_AGENT in src/zen-headers.ts to "${capturedUserAgent}".`);
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Extraction error:", err);
    process.exit(1);
  });
}
