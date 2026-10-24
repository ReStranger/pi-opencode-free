# Pi-opencode-free

Free OpenCode models in [Pi](https://github.com/earendil-works/pi), no API key.

## Why

The Pi CLI already ships an `opencode` provider, but through it the models only run on paid plans. This extension hits the same endpoint for the models advertised as free and sends the OpenCode client headers (`x-opencode-client`, `x-opencode-project`, `User-Agent`, `x-opencode-session`/`x-opencode-session-id`) on every request.

> Pure keyless: no key, no account, no paid plan. Zen's free-tier gate
> fingerprints the client on every lane (as of 2026-10-14, `body.tools`
> fingerprint added 2026-10-19, v2 client render 2026-10-20 via
> `jasonxu114514/opencode2api` PR #130 (`c780e68`) + `f0f064f`, 2.1 family
> routes and chat body synced 2026-10-23 via #141–#143 — per-process
> session reuse (a fresh id per request reads as a foreign client), the single
> fixed Anthropic `anthropic-beta` with `anthropic-version`, `?beta=true` on
> messages requests, family-scoped `/inference/openai|anthropic` routes, no
> explicit `Accept` (fetch fills `*/*`, while the SDKs' `application/json`
> default would stand out), and the 2.1 chat body layout — implicit
> `max_completion_tokens: 32000`, `strict: false` on function tools, client
> key order, no HTML escaping); this extension
> mirrors the official OpenCode client exactly — the `opencode/<channel>/<version>/<cli>`
> User-Agent (currently `2.1.1`), descending-encoded session ids (`x-opencode-session` +
> `x-opencode-session-id`), no `x-opencode-request`, the anonymous `public`
> credential, the genuine core OpenCode tool definitions (Linux `shell`
> wording), and the literal `<env>...</env>` system-prompt block on every
> request. Upstream changed this contract before (2026-09-16, 2026-10-11,
> 2026-10-14, 2026-10-19, 2026-10-20, 2026-10-23, spec-tracking `jasonxu114514/opencode2api`); when it changes
> again this pin needs updating.

> **`429 FreeUsageLimitError` has two causes.** The free tier requires a
> literal `<env>...</env>` block in the system prompt; Pi 1.4 renders its
> prompt without one, and Zen then reports the same "free usage limit"
> error even when the IP quota is untouched. The extension appends a small
> real environment block to the transcript system prompt
> (`src/zen-tools.ts`), so a fresh request should pass. If a 429 persists
> with the marker present, it is the genuine per-IP daily quota — the
> official client gets the same answer until the window resets (upstream
> issues #145/#148); wait for the reset or change the egress IP. A
> `403 FreeTierError` is the client fingerprint this extension repairs; a
> `401` means the anonymous credential was lost from the request.

Everything else is Pi's native engines with per-model dispatch, exactly like the stock `opencode` provider: streaming, reasoning, tools. There are two interception points, and they share one transform (`src/zen-headers.ts`): a `before_provider_headers` hook, and one stamping engine adapter per Zen backend — `zen-openai-completions`, `zen-openai-responses`, `zen-anthropic-messages`, `zen-google-generative-ai` (`src/zen-engines.ts`). The adapters also apply the free-tier context shape — genuine tools plus the `<env>` marker (`src/zen-tools.ts`). Models point at those adapters, so the stamp travels with the provider config even where no ambient hook runs: foreground (`async:false`) subagent children. Each request gets the OpenCode identity headers stamped on it and the anonymous `public` credential riding the auth header each backend expects, so neither the `"none"` placeholder nor any stored credential ever leaks on the wire. Upstream `opencode2api` fixes that translate to no-ops here: Bun TLS/uTLS
fingerprinting (Pi's fetch stack is stock, nothing to spoof), process-exit caps and
cooldown accounting (Pi never mass-spawns worker processes), and placeholder-key /
IP-abuse terminal detection (`pi-ai` provider-retry already refuses to retry 401/403
and deterministic 4xx — there is no retry loop to police).
Because subagent children also launch with ambient extensions disabled, the entry file additionally registers itself as a host-required child extension for the session (`src/required-child.ts`, best-effort, no-op without `pi-subagents`). Three base URLs are used (keyless inference moved off `/zen` on 2026-10-14; the 2.1 client groups routes by provider family): `https://opencode.ai/inference/openai/v1` for the OpenAI-compatible engines, `https://opencode.ai/inference/anthropic` for the Anthropic-messages backend (the Anthropic SDK appends `/v1/messages`; since
2026-10-20 its adapter additionally rides `?beta=true`, see `src/zen-engines.ts`), and `https://opencode.ai/inference/v1` for the Google engine; the models listing still lives at the legacy console origin `https://opencode.ai/zen/v1/models`.

## Install

```bash
pi install npm:pi-opencode-free
```


## Usage

Pick any `(Free)` model in Pi's model selector. The free-model catalog is
managed natively by Pi: it loads instantly from a persisted snapshot and
refreshes itself in the background on interactive startup or when opening
the model selector.

## Client sync (upstream 2026-10-23, ported 2026-10-24)

Contract pinned against the upstream renderer
([opencode2api PR #130](https://github.com/jasonxu114514/opencode2api/pull/130), commits
`c780e68` + `f0f064f` — the older 2026-10-18 render is #126; the 2.1 wave is
#141 `f9ef569`, #142 `5c5100c`, #143 `4e2edbf`):

| Change | Where here |
|--------|------------|
| `Accept: */*` on every lane (the 2.1 client sets none; fetch fills this value) | `src/zen-headers.ts` |
| Family-scoped routes: `/inference/openai/v1`, `/inference/anthropic`, Google `/inference/v1` | `src/zen-headers.ts` (`ZEN_*_BASE_URL`), `index.ts` (`baseUrlForNative`) |
| Per-process session id (`zenRootSession`) under `x-opencode-session`, `x-session-affinity`, `X-Session-Id`, `x-opencode-session-id` | `src/zen-headers.ts` |
| `anthropic-beta: interleaved-thinking-2025-05-14` + `anthropic-version: 2023-06-01`, no `Authorization` on the Anthropic lane | `src/zen-headers.ts` |
| `?beta=true` appended to the Anthropic messages endpoint (existing query preserved) | `src/zen-engines.ts` (`withAnthropicBeta`) |
| 2.1 chat body: implicit `max_completion_tokens: 32000`, `strict: false` on function tools, client key order, no HTML escaping | `src/zen-engines.ts` (`shapeZenV2ChatBody`/`composeZenChatFetch`), `COMPLETIONS_COMPAT.maxTokensField` |
| Gateway tool catalog `patch` definition (13th known name, client-side only — never injected) | `src/opencode-tools.json` + `src/zen-tools.ts` |

Snapshot restore re-derives each model's `baseUrl` from its migrated engine,
so snapshots written before the 2.1 route grouping move to the current bases
instead of staying pinned to the legacy flat `/inference` paths.

Upstream fixes that do not translate (kept for the next sync): Bun TLS/uTLS
fingerprinting, process-exit caps and cooldowns, 401/403/4xx non-retry terminal
detection (`pi-ai` provider-retry already never retries those).

## Issues & contributions

Found a problem? Open an [issue](../../issues/new). Contributions are welcome.

## Development

Uses [Bun](https://bun.sh)

```bash
bun install
bun test src/            # unit tests
bun scripts/smoke-real.ts  # live request against Zen
```

| File | Purpose |
|------|---------|
| `src/index.ts` | Native provider registration, per-model config, snapshot persistence |
| `src/discovery.ts` | Free-model discovery (Zen + models.dev enrichment) |
| `src/zen-engines.ts` | Per-backend `zen-*` engine adapters (stamp, then delegate to native) |
| `src/zen-headers.ts` | Shared OpenCode client identity: headers, session/request ids |
| `src/required-child.ts` | Self-registration for subagent children (optional `pi-subagents`) |
| `src/zen-tools.ts` | Genuine OpenCode tool definitions + free-tier `context.tools` shaping |
| `scripts/smoke-real.ts` | Live end-to-end checks against the Zen API |

## License

[GPL-3.0-or-later](./LICENSE) — © 2026 pi-opencode-free contributors
