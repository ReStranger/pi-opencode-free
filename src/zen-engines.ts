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
  applyOpenCodeFreeHeaders,
  type MutableHeaders,
  type ZenAuthLane,
} from "./zen-headers.js";
import { applyOpenCodeFreeTools } from "./zen-tools.js";

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
  return {
    ...((options ?? {}) as Record<string, unknown>),
    headers: stamped,
    transformHeaders: composeZenTransformHeaders(parent),
  } as O;
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
