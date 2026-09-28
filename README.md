# Pi-opencode-free

Free OpenCode models in [Pi](https://github.com/earendil-works/pi), no API key.

## Why

The Pi CLI already ships an `opencode` provider, but through it the models only run on paid plans. This extension hits the same endpoint for the models advertised as free and sends the OpenCode client headers (`x-opencode-client`, `x-opencode-project`, `User-Agent`, `x-opencode-session`/`x-opencode-request`) on every request.

> Pure keyless: no key, no account, no paid plan. Note that Zen currently
> rejects anonymous traffic outside OpenCode with `403 FreeTierError:
> OpenCode's free tier can only be used from within OpenCode` (verified
> 2026-09-18 — even a correct `User-Agent` + full `x-opencode-*` headers
> fail; chat, tools, and compaction/summarization all fail the same way).
> This extension sends the exact OpenCode client identity so requests are
> indistinguishable from OpenCode's own; if Zen opens anonymous access
> again, everything works with zero configuration.

Everything else is Pi's native engines with per-model dispatch, exactly like the stock `opencode` provider: streaming, reasoning, tools. There are two interception points, and they share one transform (`src/zen-headers.ts`): a `before_provider_headers` hook, and one stamping engine adapter per Zen backend — `zen-openai-completions`, `zen-openai-responses`, `zen-anthropic-messages`, `zen-google-generative-ai` (`src/zen-engines.ts`). Models point at those adapters, so the stamp travels with the provider config even where no ambient hook runs: foreground (`async:false`) subagent children. Each request gets the OpenCode identity headers stamped on it and every auth header nulled, so neither the `"none"` placeholder nor any stored credential ever leaks on the wire. Because subagent children also launch with ambient extensions disabled, the entry file additionally registers itself as a host-required child extension for the session (`src/required-child.ts`, best-effort, no-op without `pi-subagents`). Two base URLs are used: `https://opencode.ai/zen/v1` for OpenAI-compatible and Google engines, and the bare root `https://opencode.ai/zen` for the Anthropic-messages backend (same split as stock).

## Install

```bash
pi install npm:pi-opencode-free
```


## Usage

Pick any `(Free)` model in Pi's model selector. The free-model catalog is
managed natively by Pi: it loads instantly from a persisted snapshot and
refreshes itself in the background on interactive startup or when opening
the model selector.

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
| `scripts/smoke-real.ts` | Live end-to-end checks against the Zen API |

## License

[GPL-3.0-or-later](./LICENSE) — © 2026 pi-opencode-free contributors
