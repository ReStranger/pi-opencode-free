// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  getApiProvider,
  type ApiStreamSimpleFunction,
} from "@earendil-works/pi-ai/compat";
import { discoverModels, type OpenCodeModelInfo } from "./discovery.js";
import {
  OPENCODE_USER_AGENT,
  ZEN_ANTHROPIC_BASE_URL,
  ZEN_BASE_URL,
  applyOpenCodeFreeHeaders,
  canonicalSessionId,
  isKnownApi,
  isTrustedBaseUrl,
} from "./zen-headers.js";
import {
  ZEN_ANTHROPIC_API,
  ZEN_COMPLETIONS_API,
  composeZenTransformHeaders,
  nativeApiForZen,
  registerZenApiProviders,
  zenApiForNative,
  type HeaderTransform,
} from "./zen-engines.js";

// Re-exported for scripts/smoke-real.ts so the smoke path mirrors prod.
export {
  OPENCODE_USER_AGENT,
  applyOpenCodeFreeHeaders,
  canonicalSessionId,
} from "./zen-headers.js";

const PROVIDER_ID = "opencode-free";

// Per-engine compat, mirroring the stock `opencode` snapshot
// (providers/data/opencode.json) plus Zen's free-tier quirks:
// completions streams often omit finish_reason, so Pi infers stop/toolUse.
// Anthropic and Google engines get no compat — stock defines none for them
// (aside from rare per-model flags models.dev does not provide), and
// completions-only fields would be meaningless on those engines.
export const COMPLETIONS_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  // Zen often ends streams without finish_reason; let pi infer stop/toolUse
  // instead of throwing "Stream ended without finish_reason".
  supportsFinishReason: false,
  maxTokensField: "max_tokens" as const,
  requiresReasoningContentOnAssistantMessages: true,
};
export const RESPONSES_COMPAT = {
  sessionAffinityFormat: "openai-nosession" as const,
};

/** Maps a discovered model to the provider config shape: the per-model
 * `api` points at this extension's `zen-*` engine adapters — the same
 * dispatch as the stock `opencode` provider's native engines, plus the Zen
 * identity stamp on every request (see `./zen-engines.js`). */
function toProviderModel(m: OpenCodeModelInfo) {
  const native = m.api ?? "openai-completions";
  const api = zenApiForNative(native) ?? ZEN_COMPLETIONS_API;
  return {
    id: m.id.replace(/^opencode\//, ""),
    name: m.name,
    api,
    // Anthropic backend lives at the bare gateway root, like stock.
    ...(native === "anthropic-messages"
      ? { baseUrl: ZEN_ANTHROPIC_BASE_URL }
      : {}),
    reasoning: m.reasoning ?? false,
    thinkingLevelMap: m.thinkingLevelMap,
    input: (m.input?.includes("image") ? ["text", "image"] : ["text"]) as (
      | "text"
      | "image"
    )[],
    contextWindow: m.contextWindow ?? 128_000,
    maxTokens: m.maxTokens ?? 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat:
      native === "openai-responses"
        ? RESPONSES_COMPAT
        : native === "openai-completions"
          ? COMPLETIONS_COMPAT
          : undefined,
  };
}

function toStoredModel(config: ReturnType<typeof toProviderModel>) {
  return {
    ...config,
    provider: PROVIDER_ID,
    baseUrl: (config as { baseUrl?: string }).baseUrl ?? ZEN_BASE_URL,
  };
}

type ProviderModelConfig = ReturnType<typeof toProviderModel>;

/** Restores a persisted snapshot entry to provider config shape; null when the entry is not an object. */
function fromStoredModel(m: unknown): ProviderModelConfig | null {
  if (typeof m !== "object" || m === null) return null;
  const {
    provider: _provider,
    baseUrl: storedBaseUrl,
    ...rest
  } = m as {
    provider?: unknown;
    baseUrl?: unknown;
    opencodeApi?: unknown;
    api?: unknown;
  };
  // Migrate pre-zen snapshots to Zen engines: stored entries kept the
  // native engine in `api` (or forced `openai-completions` with the real
  // engine in the legacy `opencodeApi` field).
  const { opencodeApi, ...config } = rest as Record<string, unknown>;
  const legacyNative = isKnownApi(opencodeApi) ? opencodeApi : undefined;
  const currentApi = (config as { api?: unknown }).api;
  const native =
    legacyNative ??
    (typeof currentApi === "string"
      ? (nativeApiForZen(currentApi) ??
        (isKnownApi(currentApi) ? currentApi : undefined))
      : undefined);
  if (native) {
    (config as { api?: string }).api = zenApiForNative(native);
  } else {
    // Drop poisoned `api` values; absent means the provider default
    // (the Zen default completions path).
    delete (config as { api?: unknown }).api;
  }
  // Keep only a trusted non-default per-model baseUrl (Anthropic override);
  // the default comes from the provider-level `baseUrl` below. Anything else
  // (including legacy snapshots that forced every model onto the default) is
  // dropped, then re-derived from the migrated engine below.
  if (isTrustedBaseUrl(storedBaseUrl) && storedBaseUrl !== ZEN_BASE_URL) {
    (config as { baseUrl?: string }).baseUrl = storedBaseUrl;
  }
  if (
    (config as { api?: string }).api === ZEN_ANTHROPIC_API &&
    typeof (config as { baseUrl?: string }).baseUrl !== "string"
  ) {
    (config as { baseUrl?: string }).baseUrl = ZEN_ANTHROPIC_BASE_URL;
  }
  // SAFETY: stored snapshot entries are provider model configs previously
  // produced by toStoredModel (trusted fields only: the persistence-only
  // provider/default-baseUrl properties and the legacy opencodeApi routing
  // field were stripped or migrated above; api is migrated to a `zen-*`
  // engine id, baseUrl is allowlisted).
  return config as unknown as ProviderModelConfig;
}

/**
 * Rebuilds discovery input from the persisted snapshot so a failed catalog
 * fetch does not wipe reasoning/thinking metadata. Runs stored entries
 * through the same migration as the offline path (legacy `opencodeApi`,
 * baseUrl allowlist) instead of trusting raw snapshot fields.
 */
function toPreviousInput(m: unknown): OpenCodeModelInfo | null {
  if (typeof m !== "object" || m === null) return null;
  const s = m as Record<string, unknown>;
  const provider = (s as { provider?: unknown }).provider;
  if (provider !== undefined && provider !== PROVIDER_ID) return null;
  const migrated = fromStoredModel(m);
  if (
    migrated === null ||
    typeof migrated.id !== "string" ||
    typeof migrated.name !== "string"
  ) {
    return null;
  }
  // Discovery input keeps the native convention (see OpenCodeModelInfo):
  // absent means the Zen default completions path, so map the migrated
  // `zen-*` engine back (fromStoredModel already allowlisted the value).
  const native = nativeApiForZen(migrated.api);
  const discoveryApi =
    native === "openai-responses" ||
    native === "anthropic-messages" ||
    native === "google-generative-ai"
      ? native
      : undefined;
  return {
    id: migrated.id.startsWith("opencode/")
      ? migrated.id
      : `opencode/${migrated.id}`,
    name: migrated.name,
    reasoning: migrated.reasoning ?? false,
    contextWindow: migrated.contextWindow ?? 128_000,
    maxTokens: migrated.maxTokens ?? 16_384,
    thinkingLevelMap: migrated.thinkingLevelMap,
    input: migrated.input,
    api: discoveryApi,
  };
}

/**
 * The Zen request transform as a provider-level `streamSimple` wrapper:
 * composes Pi core's `transformHeaders` (attribution + hook wherever hooks
 * run) with `applyOpenCodeFreeHeaders`, then delegates straight to the
 * native engine adapter via `getApiProvider` — never to compat's top-level
 * `streamSimple` (that would route back through the composed provider and
 * recurse).
 *
 * Kept as a tested stamping primitive and for backward compatibility, but
 * the provider below no longer wires it: Pi's composer routes such a
 * wrapper solely to models whose engine matches the provider-level `api`
 * (`model.api === extension.api`), and a provider declares exactly one
 * `api` — one wrapper could never cover all four Zen backends. Per-request
 * stamping on every engine now lives in the `zen-*` engine adapters (see
 * `./zen-engines.js`), which travel with the inherited provider config —
 * that is what makes foreground (`async:false`) children work, since they
 * inherit providers but no ambient hook handlers.
 *
 * `resolveEngine` is injectable for tests; production always uses the real
 * engine registry.
 */
export function createZenStreamSimple(
  resolveEngine: (
    api: Api,
  ) => Pick<
    NonNullable<ReturnType<typeof getApiProvider>>,
    "streamSimple"
  > | undefined = (api) => getApiProvider(api),
): ApiStreamSimpleFunction {
  return (model, context, options) => {
    const engine = resolveEngine(model.api);
    if (!engine) {
      throw new Error(`No API provider registered for api: ${model.api}`);
    }
    // `transformHeaders` is threaded through request options by Pi core's
    // streamFn (sdk.ts) but is absent from pi-ai's public option types.
    const parentTransform = (
      options as
        | (SimpleStreamOptions & { transformHeaders?: HeaderTransform })
        | undefined
    )?.transformHeaders;
    const engineOptions = {
      ...options,
      transformHeaders: composeZenTransformHeaders(parentTransform),
    } as SimpleStreamOptions;
    return engine.streamSimple(model, context, engineOptions);
  };
}

export default function opencodeDirectExtension(pi: ExtensionAPI): void {
  pi.on("before_provider_headers", (event) => {
    applyOpenCodeFreeHeaders(event.headers);
  });

  // Registered once with an empty list; models come exclusively through
  // refreshModels (snapshot restore on session init, live discovery on
  // explicit refresh) — pi's native model lifecycle.
  //
  // Request stamping lives in the `zen-*` engine adapters registered
  // above — deliberately NOT in a provider-level `streamSimple`: Pi's
  // composer routes such a wrapper solely to models whose engine matches
  // the provider-level `api` (`model.api === extension.api`), and a
  // provider declares exactly one `api`, so one wrapper could never cover
  // all four Zen backends (the non-completions models depended solely on
  // the ambient hook, which never fires in foreground children → Zen 403).
  // The `zen-*` adapters travel with the inherited provider config, which
  // is what makes foreground (`async:false`) children work on every
  // engine: they inherit the provider but no ambient hook handlers.
  //
  // `api` doubles as the per-model default engine (the Zen default
  // completions path). This is not a dispatch change: every model carries
  // its own `zen-*` api (applyExtension only falls back here when a
  // snapshot entry lacks one).
  //
  // Auth: pure keyless. `apiKey: "none"` is only the placeholder Pi core
  // requires (it throws when a provider has no auth method at all); it
  // never reaches the wire — the header hook and the `zen-*` engine
  // wrappers null `Authorization` on every request. No `authHeader`, so
  // Pi-native stored keys are never exposed as `Bearer` in headers.
  registerZenApiProviders();
  pi.registerProvider(PROVIDER_ID, {
    name: "OpenCode Direct (Free)",
    baseUrl: ZEN_BASE_URL,
    api: ZEN_COMPLETIONS_API,
    apiKey: "none",
    headers: {
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      // Fallback identity for request paths with no per-request stamping
      // (defense in depth — every engine stamps via its `zen-*` adapter,
      // and the hook stamps wherever it runs). Canonical shape (never a
      // raw Pi session id); the hook and the adapters overwrite both ids
      // on every request wherever they run. Reuse across requests is safe:
      // OpenCode itself reuses headers on retry, so Zen cannot be keying
      // responses off their uniqueness.
      "x-opencode-session": canonicalSessionId(),
      "x-opencode-request": `msg_${randomUUID()}`,
      "User-Agent": OPENCODE_USER_AGENT,
    },
    models: [],
    async refreshModels(ctx) {
      if (!ctx.allowNetwork) {
        return (
          ctx.stored?.models
            .filter(
              (m: unknown) =>
                typeof m === "object" &&
                m !== null &&
                (m as { provider?: unknown }).provider === PROVIDER_ID,
            )
            .map(fromStoredModel)
            .filter((m): m is ProviderModelConfig => m !== null) ?? []
        );
      }
      if (ctx.signal.aborted) return [];
      // Previous snapshot as enrichment fallback: if the 4+ MB models.dev
      // catalog is unreachable (or lacks an entry), discoverModels re-applies
      // reasoning/thinking metadata from here instead of persisting
      // `reasoning: false` (which hides all thinking levels in Pi until the
      // next successful fetch).
      const previous = (ctx.stored?.models ?? [])
        .map(toPreviousInput)
        .filter((m): m is OpenCodeModelInfo => m !== null);
      const discovered = await discoverModels({
        signal: ctx.signal,
        previous,
      });
      if (discovered.length === 0) return []; // keep previous snapshot; retry on next refresh
      const configs = discovered.map(toProviderModel);
      await ctx.publish({
        persist: { models: configs.map(toStoredModel), checkedAt: Date.now() },
      });
      return configs;
    },
  });
}
