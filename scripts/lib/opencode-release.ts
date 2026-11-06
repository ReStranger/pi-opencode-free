// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared helpers for downloading and running official OpenCode release binaries
 * in an isolated sandbox for contract/metadata extraction.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_OWNER = "anomalyco";
export const REPO_NAME = "opencode";

export function parseSemver(tag: string): [number, number, number] {
  const m = tag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

export function semverCompare(a: string, b: string): number {
  const [a1, a2, a3] = parseSemver(a);
  const [b1, b2, b3] = parseSemver(b);
  if (a1 !== b1) return b1 - a1;
  if (a2 !== b2) return b2 - a2;
  return b3 - a3;
}

export function assetNameForPlatform(platform: string, arch: string): string {
  if (platform === "linux") {
    if (arch === "x64") return "opencode-linux-x64.tar.gz";
    if (arch === "arm64") return "opencode-linux-arm64.tar.gz";
  } else if (platform === "darwin") {
    if (arch === "x64") return "opencode-darwin-x64.zip";
    if (arch === "arm64") return "opencode-darwin-arm64.zip";
  }
  // Default to linux-x64 for CI (ubuntu-latest)
  return "opencode-linux-x64.tar.gz";
}

export async function resolveLatestReleaseTag(token?: string): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent": "pi-opencode-free-extractor",
    Accept: "application/vnd.github.v3+json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=50`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to list releases from GitHub API: HTTP ${res.status} ${res.statusText}`);
  }

  const releases = (await res.json()) as Array<{
    tag_name: string;
    prerelease?: boolean;
    draft?: boolean;
  }>;

  const stable = releases
    .filter((r) => /^v\d+\.\d+\.\d+$/.test(r.tag_name) && !r.prerelease && !r.draft)
    .map((r) => r.tag_name)
    .sort(semverCompare);

  if (stable.length === 0) {
    throw new Error("No stable semver releases found in GitHub repository");
  }

  return stable[0];
}

export async function downloadReleaseBinary(tag: string, destDir: string): Promise<string> {
  mkdirSync(destDir, { recursive: true });
  const binName = process.platform === "win32" ? "opencode.exe" : "opencode";
  const extractedBin = join(destDir, binName);
  if (existsSync(extractedBin)) {
    return extractedBin;
  }

  const assetName = assetNameForPlatform(process.platform, process.arch);
  const downloadUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${tag}/${assetName}`;
  const archivePath = join(destDir, assetName);

  console.log(`Downloading ${downloadUrl}...`);
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw new Error(`Failed to download ${downloadUrl}: HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  writeFileSync(archivePath, Buffer.from(arrayBuffer));

  console.log(`Extracting ${assetName}...`);
  if (assetName.endsWith(".tar.gz")) {
    const proc = Bun.spawn(["tar", "xzf", archivePath, "-C", destDir], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`tar extraction failed with exit code ${code}`);
  } else if (assetName.endsWith(".zip")) {
    const proc = Bun.spawn(["unzip", "-q", archivePath, "-d", destDir], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`unzip failed with exit code ${code}`);
  } else {
    throw new Error(`Unsupported archive type: ${assetName}`);
  }

  if (!existsSync(extractedBin)) {
    throw new Error(`Binary not found at expected location: ${extractedBin}`);
  }

  // Ensure binary is executable
  const chmod = Bun.spawn(["chmod", "+x", extractedBin]);
  await chmod.exited;

  return extractedBin;
}

export interface SandboxEnvironment {
  sandboxDir: string;
  runEnv: Record<string, string>;
}

export function setupSandbox(baseDir: string, mockPort: number): SandboxEnvironment {
  const sandboxDir = join(baseDir, "sandbox");
  const homeDir = join(sandboxDir, "home");
  const configDir = join(homeDir, "config", "opencode");
  mkdirSync(configDir, { recursive: true });

  const opencodeConfig = {
    $schema: "https://opencode.ai/config.json",
    providers: {
      mock: {
        name: "Mock",
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: `http://127.0.0.1:${mockPort}/v1`,
          apiKey: "test",
        },
        models: {
          m: {
            name: "m",
            family: "openai",
            package: "@opencode/ai/providers/openai-compatible",
            capabilities: { tools: true },
          },
          "gpt-5": {
            name: "gpt-5",
            family: "openai",
            package: "@opencode/ai/providers/openai-compatible",
            capabilities: { tools: true },
          },
        },
      },
    },
  };

  writeFileSync(join(configDir, "opencode.json"), JSON.stringify(opencodeConfig, null, 2));

  const runEnv: Record<string, string> = {
    ...process.env,
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, "config"),
    XDG_DATA_HOME: join(homeDir, "data"),
    XDG_CACHE_HOME: join(homeDir, "cache"),
    SHELL: "/bin/bash",
    TERM: "dumb",
  };

  return { sandboxDir, runEnv };
}
