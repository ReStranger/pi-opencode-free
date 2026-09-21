// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Self-registration as a pi-subagents required child extension.
 *
 * Problem: subagent children launch with `disableAmbientExtensions: true`,
 * so this provider extension (and its `zen-*` engine adapters + the
 * `before_provider_headers` hook) never loads in the child sandbox.
 * Requests from an `opencode-free/*` model then go out without the
 * OpenCode identity stamp and Zen rejects them with
 * `401 Invalid API key` before any tool runs.
 *
 * Fix: register this extension's own entry file as a host-required child
 * extension for the current parent session. Required paths survive agent
 * defaults and `extensions: []`, have final precedence over overrides, and
 * are loaded in every native foreground/detached/nested/recovery child —
 * exactly the set that needs the `zen-*` adapters.
 *
 * Everything here is best-effort and never throws: when `pi-subagents` is
 * not installed (plain `pi` without subagents) the dynamic import fails and
 * the parent keeps working as before, children aside.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Bounded safe id for the required-extension registry. */
export const REQUIRED_CHILD_EXTENSION_ID = "pi-opencode-free";

/** Subpath import; resolved only via dynamic import so the peer stays optional. */
const REGISTER_MODULE_SPECIFIER = "pi-subagents/required-child-extensions";

type RegisterRequiredChildExtensions = (input: {
  sessionId: string;
  extensions: { id: string; path: string }[];
}) => { dispose(): void };

export type SessionIdentityLike = {
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getSessionId?: () => string;
  };
};

/**
 * Resolves this extension's entry file (the module the child must load to
 * re-register the provider and the `zen-*` engines). Prefers the built
 * `./index.js` (dist layout) and falls back to `./index.ts` (source
 * checkout); undefined when neither exists.
 */
export function resolveSelfEntryPath(): string | undefined {
  for (const candidate of ["./index.js", "./index.ts"]) {
    try {
      const path = fileURLToPath(new URL(candidate, import.meta.url));
      if (existsSync(path)) return path;
    } catch {
      // Ignore malformed URLs / missing files and try the next candidate.
    }
  }
  return undefined;
}

/**
 * Session keys under which this extension must be registered.
 *
 * Key choice matters: at child launch pi-subagents looks the registry up by
 * the *bare* parent session id, never by file — foreground executor resolves
 * `parentPiSessionId` from `sessionManager.getSessionId()`
 * (runs/foreground/subagent-executor.js) and the background path uses
 * `parentSessionId ?? currentSessionId` (runs/background/async-execution.js).
 * So the bare id is the primary key. The session file is registered as a
 * secondary key for robustness (exotic flows where the id is unavailable
 * but the file survives); registering an extra key is harmless — lookups
 * return the same entry and the loader dedupes paths.
 */
export type SessionKeys = {
  primary?: string;
  secondary?: string;
};

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Resolves the registry keys for a session context: bare session id first,
 * session file as secondary when both exist and differ.
 */
export function resolveSessionKeys(
  ctx: SessionIdentityLike | undefined,
): SessionKeys {
  try {
    const id = clean(ctx?.sessionManager?.getSessionId?.());
    const file = clean(ctx?.sessionManager?.getSessionFile?.());
    const primary = id ?? file;
    const secondary =
      id && file && file !== id ? file : undefined;
    return { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) };
  } catch {
    // Session manager accessors are host-owned; treat failures as unknown.
    return {};
  }
}

async function loadRegisterFn(): Promise<
  RegisterRequiredChildExtensions | undefined
> {
  try {
    // Optional peer: pi-subagents is not a dependency of this package.
    // @ts-ignore - resolved at runtime only when the peer is installed.
    const mod = await import(REGISTER_MODULE_SPECIFIER);
    const fn = (mod as { registerRequiredChildExtensions?: unknown })
      .registerRequiredChildExtensions;
    return typeof fn === "function"
      ? (fn as RegisterRequiredChildExtensions)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hooks `session_start`/`session_shutdown` so the current parent session
 * registers this extension as required for its children. Safe to call once
 * per extension load; repeated `session_start` events reuse the existing
 * registration instead of throwing.
 */
export function hookRequiredChildExtension(
  pi: ExtensionAPI,
  overrides?: {
    sessionId?: string;
    secondarySessionIds?: string[];
    selfPath?: string;
    importRegister?: () => Promise<
      RegisterRequiredChildExtensions | undefined
    >;
  },
): void {
  let disposables: (() => void)[] | undefined;

  const registerOne = (
    registerFn: RegisterRequiredChildExtensions,
    sessionId: string,
    selfPath: string,
  ): (() => void) | undefined => {
    try {
      const registration = registerFn({
        sessionId,
        extensions: [{ id: REQUIRED_CHILD_EXTENSION_ID, path: selfPath }],
      });
      return registration.dispose;
    } catch (error) {
      // Reloads re-fire session_start for the same session; the first
      // registration wins and the duplicate is benign.
      if (
        !(error instanceof Error) ||
        !/already registered/.test(error.message)
      ) {
        throw error;
      }
      return undefined;
    }
  };

  const register = async (ctx: SessionIdentityLike | undefined) => {
    try {
      if (disposables) return;
      const keys = resolveSessionKeys(ctx);
      const primary = overrides?.sessionId ?? keys.primary;
      const secondaries =
        overrides?.secondarySessionIds ??
        (keys.secondary ? [keys.secondary] : []);
      const sessionIds = [
        ...new Set(
          [primary, ...secondaries].filter(
            (id): id is string => typeof id === "string" && !!id,
          ),
        ),
      ];
      const selfPath = overrides?.selfPath ?? resolveSelfEntryPath();
      if (sessionIds.length === 0 || !selfPath) return;
      const registerFn =
        (await (overrides?.importRegister ?? loadRegisterFn)()) ?? undefined;
      if (!registerFn) return;
      const created: (() => void)[] = [];
      for (const sessionId of sessionIds) {
        const dispose = registerOne(registerFn, sessionId, selfPath);
        if (dispose) created.push(dispose);
      }
      if (created.length > 0) disposables = created;
    } catch {
      // Best-effort: provider registration already happened; a missed child
      // registration must never break the parent session.
    }
  };

  pi.on("session_start", (_event, ctx) => {
    void register(ctx as SessionIdentityLike | undefined);
  });
  pi.on("session_shutdown", () => {
    try {
      for (const dispose of disposables ?? []) dispose();
    } catch {
      // Dispose is idempotent in the registry; ignore host teardown races.
    }
    disposables = undefined;
  });
}
