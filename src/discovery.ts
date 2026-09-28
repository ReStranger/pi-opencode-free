// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Discovery of free OpenCode Zen models.
 *
 * Free-tier ids come live from the Zen REST API (`/zen/v1/models`). Display
 * names, reasoning support, and limits come from the models.dev catalog;
 * anything unknown defaults to non-reasoning with conservative limits.
 * Every failure mode yields an empty list (no offline catalog).
 *
 * When the models.dev catalog is unreachable, pass `previous` (the last
 * persisted snapshot) so reasoning/thinking metadata survives instead of
 * being wiped to `reasoning: false` — otherwise Pi hides all thinking
 * levels until the next successful catalog fetch.
 */

import { OPENCODE_USER_AGENT } from "./zen-headers.js";

export interface OpenCodeModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** pi thinking level → provider value. `null` marks the level unsupported. */
  thinkingLevelMap?: Record<string, string | null>;
  /** Input modalities advertised by models.dev (subset relevant to pi). */
  input?: string[];
  /** Native Pi engine for this model, mapped from models.dev `provider.npm`
   * exactly like the stock `opencode` provider. Absent means the Zen default
   * chat/completions path (`openai-completions`). */
  api?: "openai-responses" | "anthropic-messages" | "google-generative-ai";
}

interface ModelMeta {
  name?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type: string; values?: string[] }>;
  limit?: { context?: number; output?: number };
  input?: string[];
  provider?: { npm?: string };
}

const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const MODELS_DEV_URL = "https://models.dev/api.json";
/** Refuse catalog payloads larger than this (models.dev is ~4-5 MB). */
const MAX_CATALOG_BYTES = 25_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;
// models.dev is a 4+ MB JSON; on average networks it needs 3-5s just to
// download. The old 3s budget timed out constantly, which wiped reasoning
// metadata from the persisted snapshot (see discoverModels previous
// fallback below). Keep it generous but still inside Pi's 15s selector
// budget (Zen + catalog run in parallel, so max(Zen, catalog) applies).
const CATALOG_TIMEOUT_MS = 10_000;
const FREE_REGEX = /(^(opencode\/)?.*-free$)|(^(opencode\/)?big-pickle$)/i;
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * Deadline signal. Prefers `AbortSignal.timeout`; older runtimes get an
 * explicit controller so discovery can never hang the extension load.
 */
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // The deadline must not keep the process alive on its own.
  (timer as { unref?: () => void }).unref?.();
  return controller.signal;
}

/**
 * Merges an optional caller signal (Pi aborting the refresh) with an internal
 * deadline. Prefers `AbortSignal.any`; the fallback bridges through a private
 * controller so a caller abort is never silently dropped on older runtimes.
 */
function combineSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const list = signals.filter((s): s is AbortSignal => !!s);
  const first = list[0];
  if (!first) return undefined;
  if (list.length === 1) return first;
  if (typeof AbortSignal.any === "function") return AbortSignal.any(list);
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

function baseModelId(id: string): string {
  return id.startsWith("opencode/")
    ? id.slice("opencode/".length).replace(/-free$/, "")
    : id.replace(/-free$/, "");
}

/**
 * Maps models.dev `provider.npm` to Pi's native engine, mirroring the stock
 * `opencode` provider's backend routing (see `opencode.ai/docs/zen` table).
 * Unknown/absent values fall back to the Zen default chat/completions path.
 */
function mapProviderNpmToApi(
  npm: string | undefined,
): OpenCodeModelInfo["api"] {
  if (npm === "@ai-sdk/openai") return "openai-responses";
  if (npm === "@ai-sdk/anthropic") return "anthropic-messages";
  if (npm === "@ai-sdk/google") return "google-generative-ai";
  return undefined;
}

function humanizeName(id: string): string {
  const base = id.replace(/-free$/, "").replace(/[_-]+/g, " ");
  return (
    base
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ") + " (Free)"
  );
}

/**
 * Builds pi's `thinkingLevelMap` from `reasoning_options`. Models without
 * explicit effort values get no map, deferring to the provider default.
 */
function buildThinkingLevelMap(
  meta: ModelMeta | undefined,
): Record<string, string | null> | undefined {
  if (!meta?.reasoning) return undefined;
  const options = meta.reasoning_options ?? [];
  const effort = options.find((o) => o.type === "effort")?.values ?? [];
  const hasToggle = options.some((o) => o.type === "toggle");
  if (effort.length === 0) return undefined;

  const map: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) map[level] = null;
  let sawNone = false;
  for (const value of effort) {
    if (value === "none") {
      map.off = "off";
      sawNone = true;
      continue;
    }
    if (value in map) map[value] = value;
  }
  if (hasToggle && !sawNone) map.off = "off";
  return map;
}

/**
 * Exact catalog entry for the model's own id, with no fallback. Use this for
 * anything that must come from the model itself — engine routing especially.
 */
export function lookupCatalogMetaExact(
  catalog: Record<string, ModelMeta> | undefined,
  id: string,
): ModelMeta | undefined {
  if (!catalog) return undefined;
  return catalog[normalizeSnapshotId(id)];
}

/**
 * Metadata lookup: the model's own entry first, then the base id (the
 * `-free` marketing suffix stripped), which in practice means the paid
 * sibling. The fallback is metadata-only — see `filterFreeModels` for why it
 * must never decide engine routing.
 */
export function lookupCatalogMeta(
  catalog: Record<string, ModelMeta> | undefined,
  id: string,
): ModelMeta | undefined {
  if (!catalog) return undefined;
  return catalog[normalizeSnapshotId(id)] ?? catalog[baseModelId(id)];
}

export function filterFreeModels(
  models: Array<{ id: string; name?: string }>,
  opts?: { catalog?: Record<string, ModelMeta> },
): OpenCodeModelInfo[] {
  return models
    .filter((m) => FREE_REGEX.test(m.id))
    .map((m) => {
      const meta = lookupCatalogMeta(opts?.catalog, m.id);
      // Engine routing comes only from the model's own entry: the base-id
      // fallback above describes the paid sibling, whose backend may differ,
      // and a wrong engine means a hard request failure. Missing routing
      // metadata degrades gracefully to the Zen default (chat/completions).
      const ownEntry = lookupCatalogMetaExact(opts?.catalog, m.id);
      return {
        id: m.id.startsWith("opencode/") ? m.id : `opencode/${m.id}`,
        name: m.name ?? meta?.name ?? humanizeName(m.id),
        reasoning: meta?.reasoning ?? false,
        contextWindow: meta?.limit?.context ?? 128_000,
        maxTokens: meta?.limit?.output ?? 16_384,
        thinkingLevelMap: buildThinkingLevelMap(meta),
        input: meta?.input,
        api: mapProviderNpmToApi(ownEntry?.provider?.npm),
      };
    });
}

/** Fetches models.dev catalog entries for the `opencode` provider; null on any failure. */
async function fetchModelsDevCatalog(
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<Record<string, ModelMeta> | null> {
  try {
    const res = await fetcher(MODELS_DEV_URL, { signal });
    if (!res.ok) return null;
    // Guard the 4+ MB parse: fakes in unit tests omit `headers`, so probe
    // defensively and fail closed (previous-snapshot enrichment covers it).
    const resHeaders = (res as { headers?: unknown }).headers;
    const getHeader =
      resHeaders && typeof (resHeaders as Headers).get === "function"
        ? (name: string) => (resHeaders as Headers).get(name)
        : null;
    const contentLength = getHeader?.("content-length");
    if (contentLength && Number(contentLength) > MAX_CATALOG_BYTES) {
      return null;
    }
    const contentType = getHeader?.("content-type");
    if (contentType && !contentType.includes("json")) return null;
    const cat = (await res.json()) as {
      opencode?: { models?: Record<string, unknown> };
    };
    const entries = cat?.opencode?.models;
    if (!entries) return null;
    const catalog: Record<string, ModelMeta> = {};
    for (const [id, raw] of Object.entries(entries)) {
      const m = raw as {
        name?: string;
        reasoning?: boolean;
        reasoning_options?: Array<{ type: string; values?: string[] }>;
        limit?: { context?: number; output?: number };
        modalities?: { input?: string[] };
        provider?: { npm?: string };
      };
      catalog[id] = {
        name: m.name,
        reasoning: m.reasoning === true,
        reasoning_options: m.reasoning_options,
        limit: m.limit,
        input: m.modalities?.input,
        provider: m.provider,
      };
    }
    return Object.keys(catalog).length > 0 ? catalog : null;
  } catch {
    return null;
  }
}

/** Strip the `opencode/` prefix for snapshot-vs-discovery id matching. */
function normalizeSnapshotId(id: string): string {
  return id.startsWith("opencode/") ? id.slice("opencode/".length) : id;
}

/**
 * Re-applies the previous snapshot's enrichment when the models.dev catalog
 * is unavailable. Only fills in models that would otherwise degrade to
 * `reasoning: false` with conservative limits; genuinely new ids keep
 * defaults until a catalog fetch succeeds.
 */
function applyPreviousEnrichment(
  models: OpenCodeModelInfo[],
  previous: OpenCodeModelInfo[],
  /** When set, only these normalized ids may be enriched (per-model fallback). */
  onlyIds?: Set<string>,
): OpenCodeModelInfo[] {
  if (previous.length === 0) return models;
  const prevById = new Map<string, OpenCodeModelInfo>();
  for (const p of previous) prevById.set(normalizeSnapshotId(p.id), p);
  return models.map((m) => {
    if (m.reasoning) return m; // fresh catalog truth wins
    if (onlyIds && !onlyIds.has(normalizeSnapshotId(m.id))) return m;
    const prev = prevById.get(normalizeSnapshotId(m.id));
    if (!prev?.reasoning) return m;
    return {
      ...m,
      // Only a generated placeholder gives way to the snapshot's name; a real
      // name from the endpoint or catalog always wins. `humanizeName` over the
      // bare id is exactly the placeholder `filterFreeModels` produces.
      name:
        m.name === humanizeName(normalizeSnapshotId(m.id)) && prev.name
          ? prev.name
          : m.name,
      reasoning: prev.reasoning,
      contextWindow: prev.contextWindow ?? m.contextWindow,
      maxTokens: prev.maxTokens ?? m.maxTokens,
      thinkingLevelMap: prev.thinkingLevelMap ?? m.thinkingLevelMap,
      input: prev.input ?? m.input,
      api: prev.api ?? m.api,
    };
  });
}

export async function discoverModels(opts?: {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  catalogTimeoutMs?: number;
  signal?: AbortSignal;
  previous?: OpenCodeModelInfo[];
}): Promise<OpenCodeModelInfo[]> {
  const fetcher = opts?.fetchFn ?? fetch;
  // Strict boot budget: return nothing rather than block extension load if
  // neither source answers in time.
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    // Keep the required Zen request independent from the optional, 4+ MB
    // models.dev catalog. A slow catalog must not abort an otherwise healthy
    // Zen response (the old shared signal made this return an empty list).
    const catalogBudget = opts?.catalogTimeoutMs ?? CATALOG_TIMEOUT_MS;
    const zenSignal = combineSignals(timeoutSignal(timeoutMs), opts?.signal);
    const catalogSignal = combineSignals(
      timeoutSignal(Math.min(timeoutMs, catalogBudget)),
      opts?.signal,
    );
    const [zenResult, catalogResult] = await Promise.allSettled([
      (async () => {
        const res = await fetcher(ZEN_MODELS_URL, {
          headers: {
            "x-opencode-client": "cli",
            "User-Agent": OPENCODE_USER_AGENT,
          },
          signal: zenSignal,
        });
        if (!res.ok) return null;
        return (await res.json()) as {
          data?: Array<{ id: string; name?: string }>;
        };
      })(),
      fetchModelsDevCatalog(fetcher, catalogSignal),
    ]);
    if (zenResult.status !== "fulfilled" || !zenResult.value) return [];
    const catalog =
      catalogResult.status === "fulfilled" ? catalogResult.value : null;
    const models = filterFreeModels(zenResult.value.data ?? [], {
      catalog: catalog ?? undefined,
    });
    // Catalog miss must not wipe reasoning metadata: re-apply the last
    // snapshot's enrichment so Pi keeps offering thinking-level switching
    // until the next successful catalog fetch. Whole-catalog fallback on
    // timeout/offline, per-model fallback when the catalog simply lacks an
    // entry (fresh `reasoning: true` still wins either way).
    if (opts?.previous?.length) {
      if (!catalog) return applyPreviousEnrichment(models, opts.previous);
      const missing = new Set(
        models
          .filter((m) => !lookupCatalogMeta(catalog, m.id))
          .map((m) => normalizeSnapshotId(m.id)),
      );
      if (missing.size > 0) {
        return applyPreviousEnrichment(models, opts.previous, missing);
      }
    }
    return models;
  } catch {
    return [];
  }
}
