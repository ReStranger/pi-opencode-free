// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  Api,
  Context,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
  StreamOptions,
} from "@earendil-works/pi-ai";
import {
  getApiProvider,
  registerApiProvider,
  type ApiProvider,
  type ApiStreamFunction,
  type ApiStreamSimpleFunction,
} from "@earendil-works/pi-ai/compat";
import {
  ZEN_ANTHROPIC_BASE_URL,
  ZEN_BASE_URL,
  applyOpenCodeFreeHeaders,
  type MutableHeaders,
  type ZenAuthLane,
} from "#src/zen-headers.ts";
import { applyOpenCodeFreeTools } from "#src/zen-tools.ts";

/**
 * Zen engine adapters.
 *
 * Pi's provider composer routes a provider-level `streamSimple` solely to
 * models whose engine matches the provider-level `api`
 * (`model.api === extension.api`), and a provider declares exactly one
 * `api`. One wrapper therefore can never stamp all four Zen backends
 * (completions, responses, Anthropic, Google) — the non-completions models
 * depended solely on the ambient `before_provider_headers` hook, which
 * never fires inside foreground (`async:false`) subagent children. Those
 * children leaked `Authorization: Bearer none` and got Zen `403
 * FreeTierError`.
 *
 * Instead this module registers one custom engine adapter per Zen backend
 * (`zen-*`, each stamping then delegating to its native Pi engine). Models
 * point at the `zen-*` ids, so every request — parent, background runner,
 * foreground child — travels through the stamp on every backend, with no
 * ambient hooks required. Registration is idempotent (the compat registry
 * overwrites silently) and fails loud when the engine registry is broken.
 */

/** Native Pi engines behind the Zen gateway (exactly the stock `opencode` routing). */
export type NativeZenApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

/** Custom engine ids: same dispatch as native, plus the Zen identity stamp. */
export type ZenApi = `zen-${NativeZenApi}`;

export const ZEN_COMPLETIONS_API: ZenApi = "zen-openai-completions";
export const ZEN_RESPONSES_API: ZenApi = "zen-openai-responses";
export const ZEN_ANTHROPIC_API: ZenApi = "zen-anthropic-messages";
export const ZEN_GOOGLE_API: ZenApi = "zen-google-generative-ai";

const NATIVE_TO_ZEN: Record<NativeZenApi, ZenApi> = {
  "openai-completions": ZEN_COMPLETIONS_API,
  "openai-responses": ZEN_RESPONSES_API,
  "anthropic-messages": ZEN_ANTHROPIC_API,
  "google-generative-ai": ZEN_GOOGLE_API,
};

const ZEN_TO_NATIVE: Record<ZenApi, NativeZenApi> = {
  [ZEN_COMPLETIONS_API]: "openai-completions",
  [ZEN_RESPONSES_API]: "openai-responses",
  [ZEN_ANTHROPIC_API]: "anthropic-messages",
  [ZEN_GOOGLE_API]: "google-generative-ai",
};

/** Auth lane per backend: the anonymous credential rides a different
 * header per lane, and a wrong-lane credential is an instant 403. */
const NATIVE_AUTH_LANE: Record<NativeZenApi, ZenAuthLane> = {
  "openai-completions": "openai",
  "openai-responses": "openai",
  "anthropic-messages": "anthropic",
  "google-generative-ai": "google",
};

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function isNativeZenApi(api: unknown): api is NativeZenApi {
  return typeof api === "string" && hasOwn(NATIVE_TO_ZEN, api);
}

export function isZenApi(api: unknown): api is ZenApi {
  return typeof api === "string" && hasOwn(ZEN_TO_NATIVE, api);
}

/** Maps a native engine to its stamping Zen adapter; undefined for unknown values. */
export function zenApiForNative(api: string): ZenApi | undefined {
  if (!isNativeZenApi(api)) return undefined;
  return NATIVE_TO_ZEN[api];
}

/** Maps a Zen adapter id back to its native engine; undefined for anything else. */
export function nativeApiForZen(api: unknown): NativeZenApi | undefined {
  if (!isZenApi(api)) return undefined;
  return ZEN_TO_NATIVE[api];
}

/** Auth lane for any model api a callers may pass (`zen-*` adapter or native
 * id); unknown values default to the openai lane. */
export function authLaneForApi(api: string): ZenAuthLane {
  const native = nativeApiForZen(api);
  if (!native) return "openai";
  return NATIVE_AUTH_LANE[native];
}

/** FetchFunction of pi-ai StreamOptions; defaults to globalThis.fetch. */
type ZenFetch = NonNullable<StreamOptions["fetch"]>;

/**
 * Mirrors the OpenCode 2.x client (upstream `withAnthropicBeta`): the
 * messages endpoint rides a `beta=true` query while any query a configured
 * base URL already carries is preserved. Applied only on the Zen anthropic
 * base — traffic to any other host passes through untouched.
 */
export function withAnthropicBeta(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return endpoint;
  }
  if (parsed.searchParams.get("beta") === "true") return endpoint;
  parsed.searchParams.set("beta", "true");
  return parsed.toString();
}

/**
 * Composes the anthropic-lane fetch: appends `beta=true` to Zen messages
 * requests (the v2 client marks the endpoint beta the same way) and
 * delegates everything else — including any caller-provided fetch — as is.
 */
export function composeZenAnthropicFetch(
  parent?: ZenFetch | undefined,
): ZenFetch {
  const fetchFn = parent ?? globalThis.fetch.bind(globalThis);
  return (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String(input);
    if (!url.startsWith(ZEN_ANTHROPIC_BASE_URL)) return fetchFn(input, init);
    return fetchFn(withAnthropicBeta(url), init);
  };
}

/**
 * The `max_completion_tokens` a 2.1 client puts on every chat body (upstream
 * #142). An explicit caller limit still wins, so a Pi-configured ceiling is
 * honoured.
 */
export const ZEN_V2_CHAT_MAX_COMPLETION_TOKENS = 32_000;

/**
 * The order the 2.1 client's `JSON.stringify` emits chat-body keys in
 * (upstream `v2ChatKeyOrder`). Object key order is part of the body
 * fingerprint the gate compares, and Pi's OpenAI SDK uses its own order.
 */
export const ZEN_V2_CHAT_KEY_ORDER = [
  "model",
  "messages",
  "tools",
  "stream",
  "stream_options",
  "max_completion_tokens",
] as const;

/**
 * Shapes a chat payload the way the 2.1 free-tier client sends it: the
 * client's own `max_completion_tokens` when no ceiling was requested,
 * `strict: false` on function tools that omit it, and the client's key
 * order. Returns a JSON string (plain `JSON.stringify`, so `<`, `>` and `&`
 * are not HTML-escaped).
 */
export function shapeZenV2ChatBody(
  payload: Record<string, unknown>,
): string {
  const shaped: Record<string, unknown> = { ...payload };
  if (
    !Object.prototype.hasOwnProperty.call(shaped, "max_completion_tokens") &&
    !Object.prototype.hasOwnProperty.call(shaped, "max_tokens")
  ) {
    shaped.max_completion_tokens = ZEN_V2_CHAT_MAX_COMPLETION_TOKENS;
  }
  if (Array.isArray(shaped.tools)) {
    shaped.tools = shaped.tools.map((tool) => {
      if (typeof tool !== "object" || tool === null) return tool;
      const entry = tool as { type?: unknown; function?: unknown };
      if (entry.type !== "function") return tool;
      if (
        typeof entry.function !== "object" ||
        entry.function === null ||
        Array.isArray(entry.function)
      ) {
        return tool;
      }
      const fn = entry.function as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(fn, "strict")) return tool;
      return { ...entry, function: { ...fn, strict: false } };
    });
  }
  const ordered: Record<string, unknown> = {};
  for (const key of ZEN_V2_CHAT_KEY_ORDER) {
    if (Object.prototype.hasOwnProperty.call(shaped, key)) {
      ordered[key] = shaped[key];
    }
  }
  for (const key of Object.keys(shaped).sort()) {
    if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
      ordered[key] = shaped[key];
    }
  }
  return JSON.stringify(ordered);
}

/**
 * Composes the completions-lane fetch: rewrites a Zen chat body into the 2.1
 * client's byte layout before handing it to the OpenAI SDK's fetch. Any
 * non-Zen URL, non-string body or non-chat payload passes through untouched.
 */
export function composeZenChatFetch(parent?: ZenFetch | undefined): ZenFetch {
  const fetchFn = parent ?? globalThis.fetch.bind(globalThis);
  return (input, init) => {
    if (!init || typeof init.body !== "string") return fetchFn(input, init);
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String(input);
    if (!url.startsWith(ZEN_BASE_URL)) return fetchFn(input, init);
    let payload: unknown;
    try {
      payload = JSON.parse(init.body);
    } catch {
      return fetchFn(input, init);
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload) ||
      !Array.isArray((payload as Record<string, unknown>).messages)
    ) {
      return fetchFn(input, init);
    }
    return fetchFn(input, {
      ...init,
      body: shapeZenV2ChatBody(payload as Record<string, unknown>),
    });
  };
}

export type HeaderTransform = (
  headers: ProviderHeaders,
) => ProviderHeaders | Promise<ProviderHeaders>;

/**
 * Composes Pi core's per-request `transformHeaders` (attribution + hook
 * wherever hooks run) with the Zen identity stamp, so every process —
 * parent, background runner, foreground child — emits identical traffic.
 */
export function composeZenTransformHeaders(
  parent?: HeaderTransform | undefined,
): HeaderTransform {
  return async (headers: ProviderHeaders) => {
    const base = parent ? await parent(headers) : headers;
    const stamped: ProviderHeaders = { ...(base ?? {}) };
    applyOpenCodeFreeHeaders(stamped);
    return stamped;
  };
}

/**
 * Assembles the delegated options: options.headers are stamped directly
 * with the backend's auth lane (the native engines merge them into their
 * clients and never invoke `transformHeaders` themselves — pi-ai only
 * applies that hook on its own Models request path), and the composed
 * transform stays threaded through for those Models paths anyway.
 */
function withZenHeaders<O>(
  options: O,
  nativeApi: NativeZenApi,
): O {
  const stamped: MutableHeaders = {
    ...(((options as { headers?: MutableHeaders } | undefined)?.headers ??
      {}) as MutableHeaders),
  };
  applyOpenCodeFreeHeaders(stamped, NATIVE_AUTH_LANE[nativeApi]);
  const parent = (
    options as { transformHeaders?: HeaderTransform } | undefined
  )?.transformHeaders;
  const composed: Record<string, unknown> = {
    ...((options ?? {}) as Record<string, unknown>),
    headers: stamped,
    transformHeaders: composeZenTransformHeaders(parent),
  };
  // The anthropic backend rides `?beta=true` on the Zen base, the way the
  // 2.x client marks its messages endpoint (other lanes and any non-Zen
  // base URL are left untouched). The completions lane rewrites chat bodies
  // into the 2.1 client's byte layout (max_completion_tokens, tool strict,
  // key order; upstream #142).
  if (nativeApi === "anthropic-messages") {
    composed.fetch = composeZenAnthropicFetch(
      (composed as { fetch?: ZenFetch }).fetch,
    );
  } else if (nativeApi === "openai-completions") {
    composed.fetch = composeZenChatFetch(
      (composed as { fetch?: ZenFetch }).fetch,
    );
  }
  return composed as O;
}

export type EngineResolver = (
  api: Api,
) => Pick<
  NonNullable<ReturnType<typeof getApiProvider>>,
  "stream" | "streamSimple"
> | undefined;

/**
 * Builds the `{ stream, streamSimple }` pair for one Zen backend: stamp via
 * a composed `transformHeaders`, then delegate straight to the native
 * engine adapter — never to compat's top-level `stream`/`streamSimple`
 * (that would resolve the `zen-*` id back to this same wrapper and
 * recurse).
 *
 * Pi-ai's `registerApiProvider` wraps every native engine with a strict
 * `model.api === api` guard (`Mismatched api: ... expected ...`). Models
 * reaching this adapter carry the `zen-*` id, so the model must be
 * re-keyed to `nativeApi` before delegating — otherwise every non-default
 * backend fails with e.g. `Mismatched api: zen-openai-responses expected
 * openai-responses`.
 *
 * `resolveEngine` is injectable for tests; production always uses the real
 * engine registry.
 */
export function createZenEngineFunctions(
  nativeApi: NativeZenApi,
  resolveEngine: EngineResolver = (api) => getApiProvider(api),
): Pick<ApiProvider, "stream" | "streamSimple"> {
  const resolve = () => {
    const engine = resolveEngine(nativeApi);
    if (!engine) {
      throw new Error(`No API provider registered for api: ${nativeApi}`);
    }
    return engine;
  };
  // Re-key to the native engine id; all other model fields (provider,
  // baseUrl, compat, ...) travel unchanged so Zen routing is preserved.
  // The context is shaped for the free tier in the same step: genuine core
  // OpenCode tools ride every `zen-*` dispatch (pi-ai has no payload
  // transform, so the tool list is the only request-shaping surface).
  const toNativeModel = (model: Model<Api>): Model<Api> => ({
    ...model,
    api: nativeApi,
  });
  const stream: ApiStreamFunction = (
    model: Model<Api>,
    context: Context,
    options?: StreamOptions,
  ) =>
    resolve().stream(
      toNativeModel(model),
      applyOpenCodeFreeTools(context),
      withZenHeaders(options, nativeApi),
    );
  const streamSimple: ApiStreamSimpleFunction = (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) =>
    resolve().streamSimple(
      toNativeModel(model),
      applyOpenCodeFreeTools(context),
      withZenHeaders(options, nativeApi),
    );
  return { stream, streamSimple };
}

const ZEN_SOURCE_ID = "pi-opencode-free";

/**
 * Registers the four `zen-*` engine adapters. Idempotent: re-registering
 * overwrites with an equivalent wrapper. The `register` parameter is
 * injectable so tests can capture registrations without touching the
 * global engine registry.
 */
export function registerZenApiProviders(
  register: typeof registerApiProvider = registerApiProvider,
): ZenApi[] {
  const ids: ZenApi[] = [];
  for (const native of Object.keys(NATIVE_TO_ZEN) as NativeZenApi[]) {
    const zen = NATIVE_TO_ZEN[native];
    const registration: ApiProvider = {
      api: zen,
      ...createZenEngineFunctions(native),
    };
    register(registration, ZEN_SOURCE_ID);
    ids.push(zen);
  }
  return ids;
}
