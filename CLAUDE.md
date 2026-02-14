# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Router (CCR) routes Claude Code requests to different LLM providers. Monorepo with five packages:

- **core** (`@musistudio/llms`): Core server framework — transformers, API routing, stream processing
- **server** (`@CCR/server`): Business logic — scenario routing, token counting, agents, config management
- **shared** (`@CCR/shared`): Constants, utilities, preset system
- **cli** (`@CCR/cli`): Command-line tool providing the `ccr` command
- **ui** (`@CCR/ui`): Web management interface (React + Vite)

Dependency graph: `cli → server → core → shared` (ui is standalone).

## Build & Install

### Build all packages (must follow order: shared → core → server → cli → ui)

```bash
pnpm build
```

### Install globally for testing

**IMPORTANT**: `bun install -g` has tgz caching issues — the installed binary may not update. Use direct copy instead:

```bash
pnpm build && cp packages/cli/dist/cli.js ~/.local/share/bun/install/global/node_modules/@CCR/cli/dist/cli.js && ccr restart
```

### Development mode

```bash
pnpm dev:cli        # CLI (ts-node)
pnpm dev:server     # Server (ts-node)
pnpm dev:ui         # UI (Vite dev server)
pnpm dev:core       # Core (nodemon)
```

### Publish

```bash
pnpm release        # Build and publish all packages
```

## Core Architecture

### 1. Routing System (`packages/server/src/utils/router.ts`)

Scenario routing priority (checked in this order, first match wins):

1. **Subagent tag** — `<CCR-SUBAGENT-MODEL>` in system entries only (highest priority)
2. **webSearch** — request tools contain `web_search_*` type
3. **longContext** — token count exceeds `longContextThreshold` (default 60000)
4. **background** — model name contains “claude” + “haiku”
5. **think** — `req.body.thinking` is present
6. **Explicit `provider,model`** — comma-separated model string
7. **Default** — `Router.default`

**Critical ordering**: webSearch MUST be checked before background, because Claude Code sends web search requests using Haiku models.

Project-level routing: `~/.claude-code-router/<project-folder>/config.json` overrides global Router.

### 2. Bypass Mode (`packages/core/src/api/routes.ts`)

When a provider has exactly one transformer matching the endpoint transformer, ALL transformers are skipped (bypass mode). The raw Anthropic request is forwarded directly. This means Anthropic-specific parameters (`thinking`, `context_management`, `web_search_20250305`, `tool_choice`) pass through unmodified.

**Implication**: Non-Anthropic providers using `/v1/messages` endpoint + Anthropic transformer trigger bypass. Use an intermediate proxy (e.g., CPA) for protocol translation when routing to non-Anthropic providers.

### 3. Transformer System (`packages/core/`)

Transformers handle request/response format conversion between Claude API and provider-specific APIs. `@musistudio/llms` is a **local workspace package** (NOT an external dependency), type definitions in `packages/server/src/types.d.ts`.

Built-in transformers: `anthropic`, `deepseek`, `gemini`, `openrouter`, `groq`, `maxtoken`, `tooluse`, `reasoning`, `enhancetool`, etc. Custom transformers loaded via `transformers` array in config.

### 4. Agent System (`packages/server/src/agents/`)

Pluggable modules: `shouldHandle` → `reqHandler` → inject tools → intercept tool calls in `onSend` → execute → stream results. Built-in: `imageAgent`.

### 5. SSE Stream Processing

- `SSEParserTransform`: SSE text → event objects
- `SSESerializerTransform`: event objects → SSE text
- `rewriteStream`: intercepts stream for agent tool call handling

### 6. Configuration

Location: `~/.claude-code-router/config.json` (JSON5, supports comments and env var interpolation `$VAR`/`${VAR}`). Automatic backups (last 3). Changes require `ccr restart`.

### 7. Logging

- **Server logs** (pino): `~/.claude-code-router/logs/ccr-*.log` — HTTP requests, routing decisions. Lines can be tens of KB; use Python scripts (not cat/tail) for parsing.
- **Application logs**: `~/.claude-code-router/claude-code-router.log`
- Log level: `LOG_LEVEL` config (fatal/error/warn/info/debug/trace)

## CLI Commands

```bash
ccr start | stop | restart | status    # Service management
ccr code                                # Execute claude command
ccr model                               # Interactive model selection
ccr preset export|install|list|info|delete  # Preset management
ccr activate                            # Output shell env vars
ccr ui                                  # Open Web UI
ccr statusline                          # Statusline (reads JSON from stdin)
```

## Subagent Routing

```
<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>
```

Only scanned in system entries to prevent routing leaks from user messages.

## Development Notes

1. **Node.js**: Requires >= 20.0.0
2. **Package manager**: pnpm (workspace protocol)
3. **Build tools**: esbuild (core/server/shared/cli), Vite (ui). Core builds both CJS and ESM.
4. **No test suite**: Project has no test files or test framework configured.
5. **Code comments**: MUST be written in English.
6. **Documentation**: Add to the docs project, not standalone md files.

## Log Verification Scripts (`.claude/scripts`)

- `verify_trace_markers.py`: Validate TRACE marker routing results in CCR logs (subagent routing correctness, no tag leak to lead, no provider errors in TRACE requests)
- `check_log_error.py`: Count specific error messages in CCR logs and print related reqIds

Examples:

```bash
uv run .claude/scripts/verify_trace_markers.py --prefix TRACE_TEST_20260214_A1_
uv run .claude/scripts/check_log_error.py --needle "cache_control cannot be set for empty text blocks"
```

Both scripts default to the latest `~/.claude-code-router/logs/ccr-*.log`, and can also target a specific file via `--log`.

## Configuration Example

- Main config example: README.md
- Custom router: `custom-router.example.js`
