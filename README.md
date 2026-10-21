# Pi-opencode-free

Free OpenCode models in [Pi](https://github.com/earendil-works/pi), no API key.

## Why

The Pi CLI already ships an `opencode` provider, but through it the models only run on paid plans. This extension hits the same endpoint for the models advertised as free and sends the OpenCode client headers (`x-opencode-client`, `x-opencode-project`, `User-Agent`, `x-opencode-session`/`x-opencode-session-id`) on every request.

> Pure keyless: no key, no account, no paid plan. Zen's free-tier gate
> fingerprints the client on every lane (as of 2026-10-14, `body.tools`
> fingerprint added 2026-10-19, v2 client render 2026-10-20 via
> `jasonxu114514/opencode2api` #126 — the streaming `Accept` header, per-process
> session reuse (a fresh id per request reads as a foreign client), and the
> Anthropic `anthropic-beta`/`anthropic-version` pins with `?beta=true` on
> messages requests); this extension
> mirrors the official OpenCode client exactly — the `opencode/<channel>/<version>/<cli>`
> User-Agent (currently `2.0.32`), descending-encoded session ids (`x-opencode-session` +
> `x-opencode-session-id`), no `x-opencode-request`, the anonymous `public`
> credential, and the genuine core OpenCode tool definitions (Linux `shell`
> wording) on every
> request. Upstream changed this contract before (2026-09-16, 2026-10-11,
> 2026-10-14, 2026-10-19, 2026-10-20, spec-tracking `jasonxu114514/opencode2api`); when it changes
> again this pin needs updating.

Everything else is Pi's native engines with per-model dispatch, exactly like the stock `opencode` provider: streaming, reasoning, tools. There are two interception points, and they share one transform (`src/zen-headers.ts`): a `before_provider_headers` hook, and one stamping engine adapter per Zen backend — `zen-openai-completions`, `zen-openai-responses`, `zen-anthropic-messages`, `zen-google-generative-ai` (`src/zen-engines.ts`). Models point at those adapters, so the stamp travels with the provider config even where no ambient hook runs: foreground (`async:false`) subagent children. Each request gets the OpenCode identity headers stamped on it and the anonymous `public` credential riding the auth header each backend expects, so neither the `"none"` placeholder nor any stored credential ever leaks on the wire. Upstream `opencode2api` fixes that translate to no-ops here: Bun TLS/uTLS
fingerprinting (Pi's fetch stack is stock, nothing to spoof), process-exit caps and
cooldown accounting (Pi never mass-spawns worker processes), and placeholder-key /
IP-abuse terminal detection (`pi-ai` provider-retry already refuses to retry 401/403
and deterministic 4xx — there is no retry loop to police).
Because subagent children also launch with ambient extensions disabled, the entry file additionally registers itself as a host-required child extension for the session (`src/required-child.ts`, best-effort, no-op without `pi-subagents`). Two base URLs are used (keyless inference moved off `/zen` on 2026-10-14): `https://opencode.ai/inference/v1` for the OpenAI-compatible and Google engines, and the bare root `https://opencode.ai/inference` for the Anthropic-messages backend (the Anthropic SDK appends `/v1/messages`; since
2026-10-20 its adapter additionally rides `?beta=true`, see `src/zen-engines.ts`); the models listing still lives at the legacy console origin `https://opencode.ai/zen/v1/models`.

## Install

```bash
pi install npm:pi-opencode-free
```


## Usage

Pick any `(Free)` model in Pi's model selector. The free-model catalog is
managed natively by Pi: it loads instantly from a persisted snapshot and
refreshes itself in the background on interactive startup or when opening
the model selector.

## v2 sync (2026-10-20)

Contract pinned against the upstream renderer
([opencode2api #126](https://github.com/jasonxu114514/opencode2api/pull/126), commit
`f0f064f`; upstream refs `c780e68`, `3e83185`, `fa9a255`, `8cc5e96`, `0bb23c7`,
`ea947bc`, `d04ff33`):

| Change | Where here |
|--------|------------|
| `Accept: application/json, text/event-stream` on every lane | `src/zen-headers.ts` |
| Per-process session id (`zenRootSession`) under `x-opencode-session`, `x-session-affinity`, `X-Session-Id`, `x-opencode-session-id` | `src/zen-headers.ts` |
| `anthropic-beta: interleaved-thinking-2025-05-14` + `anthropic-version: 2023-06-01`, no `Authorization` on the Anthropic lane | `src/zen-headers.ts` |
| `?beta=true` appended to the Anthropic messages endpoint (existing query preserved) | `src/zen-engines.ts` (`withAnthropicBeta`) |
| Gateway tool catalog `patch` definition (13th known name, client-side only — never injected) | `src/opencode-tools.json` + `src/zen-tools.ts` |

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
