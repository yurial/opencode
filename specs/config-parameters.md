# OpenCode V1 Configurable Parameters

Status: stable
Spec source of truth for: the V1 runtime configuration surface — every configurable parameter, its responsibility, allowed values, default, and the channel (config file, environment variable, CLI flag) through which it is set.

## Overview

V1 opencode is configured through three channels: JSONC config documents
(`opencode.json`/`opencode.jsonc`/legacy `config.json` plus resource directories),
environment variables, and CLI flags. This specification enumerates the complete
V1 parameter surface as implemented by the V1 schema and loader, and fixes the
file topology, merge precedence, and substitution semantics that produce the
effective runtime configuration.

## Scope

In: all keys of the V1 config schema (root and nested), the `tui.json` TUI
config surface, resource files discovered from config directories (agents,
commands, skills, plugins, themes, instruction files), opencode-read environment
variables, and CLI flags that change effective configuration.

Out (non-goals): the V2 configuration surface (see config-v2), the OpenAPI
HTTP contract, provider plugin behavior beyond its config inputs, and the
content of built-in agents/commands/skills.

## Definitions

- config-v1/channel: one of the three configuration input kinds — file key,
  environment variable, CLI flag.
- config-v1/config-document: one parsed JSONC file (`opencode.json`,
  `opencode.jsonc`, legacy `config.json`, managed preferences JSON, or remote
  JSON) contributing keys to the effective configuration.
- config-v1/global-config: config documents read from the XDG config
  directory (`$XDG_CONFIG_HOME/opencode`, overridable via `OPENCODE_CONFIG_DIR`).
- config-v1/project-config: config documents discovered by walking from the
  working directory up to the worktree root.
- config-v1/instance-config: the merged effective configuration for one
  project instance, produced by the precedence rules in this spec.
- config-v1/managed-config: administrator-authored config from a system
  managed directory or macOS managed preferences (MDM).
- config-v1/prime-time: a model-level usage window combining `primeTimeStart`,
  `primeTimeEnd`, and `primeTimeDay`; while the process clock is inside the
  window (R17) the model must not be used.
- config-v1/remote-config: config fetched from a well-known URL of an
  authenticated server or from an active organization account.
- config-v1/tui-config: a `tui.json`/`tui.jsonc` document configuring the
  terminal UI, loaded by the TUI config loader rather than the main loader.
- config-v1/variable-substitution: the `{env:VAR}` and `{file:path}` token
  expansion applied to config document text before parsing.

## Interface

### Channels

| Channel | Consumer | Notes |
|---|---|---|
| File keys | Config loader (`packages/opencode/src/config`) | JSONC, trailing commas allowed; unknown keys ignored |
| Environment variables | process env read at module load or access time | Several are evaluated lazily per access |
| CLI flags | yargs commands (`packages/opencode/src/cli`) | Flags that duplicate config keys override config |

### File topology

| Location | Files | Purpose |
|---|---|---|
| Global config dir | `config.json`, `opencode.json`, `opencode.jsonc` | User-global settings; a missing default file is seeded with `$schema` only |
| Ancestor directories (cwd → worktree root) | `opencode.json`, `opencode.jsonc` | Project config; closest file wins |
| `.opencode` directories (cwd → worktree root, then `~/.opencode`) | `opencode.json`, `opencode.jsonc` + resource dirs | Project/global resource bundles |
| `OPENCODE_CONFIG_DIR` | `opencode.json`, `opencode.jsonc` + resources | Extra config directory appended last |
| `OPENCODE_CONFIG` (env) | any file path | Single explicit config file |
| `OPENCODE_CONFIG_CONTENT` (env) | JSONC text | Inline config content |
| Managed dir | `opencode.json`, `opencode.jsonc` | Platform system config (see config-v1/managed-config) |
| macOS managed preferences | `ai.opencode.managed` plist | Overrides everything (converted via `plutil`) |
| TUI | `tui.json`, `tui.jsonc` in the same locations | Terminal UI settings (see TUI table) |

Resource directories inside every config directory: `agent(s)/`, `mode(s)/`,
`command(s)/`, `skill(s)/`, `plugin(s)/`, `themes/`.

### Core and identity keys

| Key | Type | Allowed / range | Default | Responsibility |
|---|---|---|---|---|
| `$schema` | string | any URL; auto-set to `https://opencode.ai/config.json` when absent (file is rewritten once) | — | Editor validation |
| `shell` | string | unvalidated (must resolve to an executable at use) | OS default | Shell for terminal and bash tool |
| `username` | string | unvalidated | `os.userInfo().username`, fallback `user` | Display name in conversations |
| `model` | string | `provider/model-id`; unvalidated until model resolution | none | Default model |
| `small_model` | string | same format | none | Utility model (title generation) |
| `default_agent` | string | primary agent name; invalid value falls back to `build` | `build` | Default agent |
| `subagent_depth` | int ≥ 0 | non-negative | 1 | Max subagent nesting depth |
| `share` | enum | `manual` \| `auto` \| `disabled` | runtime default | Session sharing behavior |
| `autoshare` | boolean | deprecated alias | — | `true` + no `share` → `share: "auto"` |
| `autoupdate` | bool \| `notify` | `true`, `false`, `"notify"` | runtime default | Auto-update behavior |
| `snapshot` | boolean | — | `true` | Filesystem snapshot tracking (undo/revert) |
| `enterprise.url` | string | URL, unvalidated | none | Enterprise share endpoint |
| `logLevel` | enum | `DEBUG` \| `INFO` \| `WARN` \| `ERROR` | — | Dead key: no config consumer; actual level comes from `OPENCODE_LOG_LEVEL` (env) |

### Instructions and project resources

| Key | Type | Allowed / range | Default | Responsibility |
|---|---|---|---|---|
| `instructions` | string[] | paths, glob patterns, URLs | none | Extra ambient instruction sources; merged across documents by concatenation + dedup |
| `skills.paths` | string[] | dirs (`~` expanded; relative → cwd) | none | Extra skill folders |
| `skills.urls` | string[] | URLs serving `index.json` skill lists | none | Remote skill sources (cached under global cache `skills/`) |
| `references` | object | alias → local path or git reference (from models.dev reference shape) | none | Named external context |
| `reference` | object | deprecated singular alias | — | Same as `references` |
| `command.<name>` | object | see Command entries table | none | Slash command config (usually authored as Markdown) |
| `watcher.ignore` | string[] | glob patterns | none | Filesystem watcher ignore list |

### Agent entries (`agent.<name>`, deprecated `mode.<name>`)

`mode` entries merge into `agent` with `mode: "primary"`.

| Key | Type | Allowed / range | Default | Responsibility |
|---|---|---|---|---|
| `model` | string | `provider/model-id` | inherited | Agent model |
| `variant` | string | model variant id | none | Default model variant for this agent |
| `prompt` | string | any (Markdown body in `.md` files) | built-in | System prompt |
| `description` | string | any | none | When to use the agent |
| `temperature` | number | finite, unvalidated range | model default | Sampling temperature |
| `top_p` | number | finite, unvalidated range | model default | Nucleus sampling |
| `mode` | enum | `subagent` \| `primary` \| `all` | entry-dependent | Runtime role |
| `hidden` | boolean | — | `false` | Hide from autocomplete (subagents only) |
| `disable` | boolean | — | `false` | Deactivate the agent |
| `color` | string | `#RRGGBB` or theme name (`primary`, `secondary`, `accent`, `success`, `warning`, `error`, `info`) | none | Display color |
| `steps` | int > 0 | positive | model-dependent | Max agentic iterations before text-only response |
| `maxSteps` | int > 0 | deprecated alias for `steps` | — | — |
| `tools` | object | tool name → boolean; deprecated | — | Converted to permission rules (`write`/`edit`/`patch` collapse to `edit`) |
| `permission` | object/string | see Permissions table | none | Agent-local permission rules |
| `options` | object | any (unknown agent keys fold here) | none | Provider option overrides |

### Permissions

| Key | Type | Allowed / range | Responsibility |
|---|---|---|---|
| `permission` (string form) | enum | `ask` \| `allow` \| `deny` | Applies the action to resource `*` for every known tool |
| `permission.<tool>` | enum | `ask` \| `allow` \| `deny` | Simple per-tool rule |
| `permission.<tool>` | object | resource pattern → `ask` \| `allow` \| `deny` | Per-resource rules; key order preserved (precedence by order) |
| `tools` (top-level) | object | tool → boolean; deprecated | Converted to `permission` (write/edit/patch → `edit`), then explicit `permission` wins |

Known tool keys: `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`,
`external_directory`, `todowrite`, `question`, `webfetch`, `websearch`, `lsp`,
`doom_loop`, `skill`; other keys pass through as tool names.

### Providers and models

| Key | Type | Allowed / range | Default | Responsibility |
|---|---|---|---|---|
| `provider.<id>.name` | string | any | provider id | Display name |
| `provider.<id>.api` | string | URL | catalog value | Endpoint override |
| `provider.<id>.env` | string[] | env var names | catalog value | Credential env candidates (availability detection) |
| `provider.<id>.npm` | string | npm package | catalog value | AI SDK integration package |
| `provider.<id>.id` | string | any | — | Custom provider id override |
| `provider.<id>.whitelist` / `blacklist` | string[] | model ids | — | Filter catalog models |
| `provider.<id>.options.apiKey` | string | any | none | API key override |
| `provider.<id>.options.baseURL` | string | URL | none | Base URL override |
| `provider.<id>.options.enterpriseUrl` | string | URL | none | GitHub Enterprise URL (copilot) |
| `provider.<id>.options.setCacheKey` | boolean | — | `false` | Enable promptCacheKey |
| `provider.<id>.options.timeout` | int > 0 \| `false` | ms; `false` disables | provider default | Full-request timeout |
| `provider.<id>.options.headerTimeout` | int > 0 \| `false` | ms; `false` disables | provider default | Response-header timeout |
| `provider.<id>.options.chunkTimeout` | int > 0 | ms | none | Max gap between SSE chunks |
| `provider.<id>.options.retries` | int 0–1000000 | attempts | `5` | Max retry attempts for failed LLM requests to this provider. `0` disables retries. Counted per request: 1 initial attempt + `retries` retries. |
| `provider.<id>.options.*` | any | passthrough | — | AI SDK provider options |
| `provider.<id>.models.<mid>` | object | see model fields | — | Model override/definition |
| Model `id`/`name`/`family`/`release_date` | string | unvalidated | — | Metadata |
| Model `attachment`/`reasoning`/`temperature`/`tool_call`/`experimental` | boolean | — | catalog | Capability flags |
| Model `primeTimeStart` / `primeTimeEnd` | string | ISO 8601 time-of-day `HH:MM[:SS]` (omitted seconds = `0`), optionally suffixed `Z`, `±HH:MM`, `±HHmm`, or `±HH`; no suffix = process-local time; any malformed bound disables the window (fail-open, R17) | none | Prime-time window bounds; while the window is active the model cannot be used (R18) |
| Model `primeTimeDay` | string[] | subset of `sun`..`sat`; missing or empty disables the window | none | Weekdays the prime-time window applies to (process-local weekday of the current moment) |
| Model `interleaved` | bool \| `reasoning` \| `reasoning_content` \| `reasoning_text` \| string \| `{field}` | any | catalog | Interleaved thinking field |
| Model `cost.{input,output,cache_read,cache_write}` | finite number | per-Mtok pricing | catalog | Cost metadata |
| Model `cost.context_over_200k` | object | same cost fields | none | Tiered pricing above 200k context |
| Model `limit.{context,output}` | finite number; `limit.input` optional | tokens | catalog | Context/output limits |
| Model `modalities.{input,output}` | array of `text` \| `audio` \| `image` \| `video` \| `pdf` | enum array | catalog | Modality support |
| Model `status` | enum | `alpha` \| `beta` \| `deprecated` \| `active` | — | Catalog status |
| Model `options` / `headers` | object | any / string map | none | Request overrides |
| Model `variants.<vid>` | object | `disabled?: boolean` + any | — | Variant config |
| `disabled_providers` | string[] | provider ids | none | Disable auto-loaded providers |
| `enabled_providers` | string[] | provider ids | none | Exclusive allowlist |

### MCP servers (`mcp.<name>`)

| Key | Type | Allowed / range | Default | Responsibility |
|---|---|---|---|---|
| `mcp.<name>` | object | `{enabled: boolean}` disables/enables without redefining | — | Toggle shortcut |
| Local `type` | literal | `local` | — | Connection kind discriminator |
| Local `command` | string[] | argv | required | Server command |
| Local `cwd` | string | dir; relative → workspace dir | process cwd | Working directory |
| Local `environment` | object | string map | none | Server env |
| Local/Remote `enabled` | boolean | — | `true` | Startup enablement |
| Local/Remote `timeout` | int > 0 | ms | `5000` | Request timeout |
| Remote `type` | literal | `remote` | — | Connection kind discriminator |
| Remote `url` | string | URL, unvalidated | required | Server URL |
| Remote `headers` | object | string map | none | Request headers |
| Remote `oauth` | `false` \| object | `false` disables OAuth auto-detection | auto-detect | OAuth config |
| `oauth.clientId` / `clientSecret` / `scope` | string | any | dynamic registration | OAuth client |
| `oauth.callbackPort` | int | 1–65535 | `19876` | Local callback port |
| `oauth.redirectUri` | string | URL | `http://127.0.0.1:19876/mcp/oauth/callback` | Redirect URI |

### Tooling and IO limits

| Key | Type | Allowed / range | Default | Responsibility |
|---|---|---|---|---|
| `lsp` | bool \| object | `true` enables built-ins, `false` disables, object overrides | runtime default | LSP subsystem |
| `lsp.<id>.command` | string[] | argv | built-in | Server command (required for custom) |
| `lsp.<id>.extensions` | string[] | suffixes | built-in | File association (required for non-builtin ids) |
| `lsp.<id>.disabled` | boolean | — | `false` | Disable one server |
| `lsp.<id>.env` | object | string map | none | Server env |
| `lsp.<id>.initialization` | object | any | none | Init options |
| `formatter` | bool \| object | same tri-state as `lsp` | runtime default | Formatter subsystem |
| `formatter.<id>.command` | string[] | argv | built-in | Formatter command |
| `formatter.<id>.environment` | object | string map | none | Formatter env |
| `formatter.<id>.extensions` | string[] | suffixes | built-in | File association |
| `formatter.<id>.disabled` | boolean | — | `false` | Disable one formatter |
| `attachment.image.auto_resize` | boolean | — | `true` | Resize oversize images |
| `attachment.image.max_width` / `max_height` | int > 0 | px | `2000` | Resize/reject threshold |
| `attachment.image.max_base64_bytes` | int > 0 | bytes | `5242880` | Payload cap |
| `tool_output.max_lines` | int > 0 | lines | `2000` | Truncation threshold |
| `tool_output.max_bytes` | int > 0 | bytes | `51200` | Truncation threshold |
| `compaction.auto` | boolean | — | `true` | Auto-compaction on context pressure |
| `compaction.prune` | boolean | — | `false` | Prune old tool outputs |
| `compaction.tail_turns` | int ≥ 0 | turns | unlimited | Verbatim recent-turn retention |
| `compaction.preserve_recent_tokens` | int ≥ 0 | tokens | runtime default | Verbatim token budget |
| `compaction.reserved` | int ≥ 0 | tokens | runtime default | Compaction headroom |

### Plugins

| Key | Type | Allowed / range | Responsibility |
|---|---|---|---|
| `plugin` | array of string \| `[spec, options]` | npm spec, file URL, or relative path (resolved against the declaring config file) | Ordered plugin load list; duplicates deduped by npm package name or exact file URL, later declaration wins |

Local plugin files are also auto-discovered from `plugin(s)/*.{ts,js}` in every
config directory.

### Server

| Key | Type | Allowed / range | Default | Responsibility |
|---|---|---|---|---|
| `server.port` | int > 0 | TCP port | random | Listen port |
| `server.hostname` | string | hostname | `127.0.0.1`; `0.0.0.0` when mdns on and hostname unset | Listen address |
| `server.mdns` | boolean | — | `false` | mDNS advertisement |
| `server.mdnsDomain` | string | domain | `opencode.local` | mDNS domain |
| `server.cors` | string[] | origins | none | Extra CORS origins (concatenated with CLI `--cors`) |

### Deprecated keys

| Key | Status |
|---|---|
| `layout` | Ignored (stretch layout always) |
| `logLevel` | Dead (no consumer; use `OPENCODE_LOG_LEVEL`) |
| `autoshare` | Alias → `share` |
| `reference` | Alias → `references` |
| `mode` | Alias → `agent` (entries become `primary`) |
| `maxSteps` (agent) | Alias → `steps` |
| `tools` | Alias → `permission` |
| `theme`/`keybinds`/`tui` in `opencode.json` | Stripped on load; migrated to `tui.json` with `.tui-migration.bak` backup |

### Experimental (V1)

| Key | Type | Responsibility |
|---|---|---|
| `experimental.disable_paste_summary` | boolean | Disable paste summary |
| `experimental.batch_tool` | boolean | Enable batch tool |
| `experimental.openTelemetry` | boolean | OTel spans for AI SDK calls |
| `experimental.primary_tools` | string[] | Tools restricted to primary agents |
| `experimental.continue_loop_on_deny` | boolean | Continue loop after denied tool call |
| `experimental.mcp_timeout` | int > 0 (ms) | MCP request timeout |
| `experimental.policies` | policy statement array | Resource access policies (e.g. provider use) |

### TUI config (`tui.json`)

| Key | Type | Allowed / range | Default | Responsibility |
|---|---|---|---|---|
| `$schema` | string | — | `https://opencode.ai/tui.json` | Editor validation |
| `theme` | string | theme name from built-ins or `themes/*.json` | terminal-adaptive default | Color theme |
| `keybinds.<command>` | string \| keystroke \| binding object \| array \| `false` \| `none` | 184 named commands (see `packages/tui/src/config/keybind.ts`); unknown keys dropped | per-command | Keybinding override; `leader` prefix is `ctrl+x` |
| `leader_timeout` | int > 0 | ms | `2000` | Leader key timeout |
| `attention.enabled` | boolean | — | `false` | Attention subsystem master switch |
| `attention.notifications` | boolean | — | `true` | Terminal notifications |
| `attention.sound` | boolean | — | `true` | Sound feedback |
| `attention.volume` | number | 0 ≤ v ≤ 1 | `0.4` | Sound volume |
| `attention.sound_pack` | string | pack name | `opencode.default` | Sound pack |
| `attention.sounds.<event>` | string | file path per event (`default`, `question`, `permission`, `error`, `done`, `subagent_done`), resolved relative to the config file | pack default | Per-event sound override |
| `prompt.max_height` | int > 0 | rows | terminal-dependent | Prompt textarea cap |
| `prompt.max_width` | int > 0 \| `auto` | — | `auto` | Prompt width cap |
| `scroll_speed` | number ≥ 0.001 | lines per step | runtime default | Scroll speed |
| `scroll_acceleration.enabled` | boolean | — | runtime default | Scroll acceleration |
| `diff_style` | enum | `auto` \| `stacked` | `auto` | Diff rendering style |
| `cursor.style` | enum | `block` \| `underline` \| `line` \| `default` | `block` | Cursor shape |
| `cursor.blinking` | boolean | — | `true` | Cursor blink (no effect with `default`) |
| `mouse` | boolean | — | `true` | Mouse capture |
| `plugin` | array of string \| `[spec, options]` | like main `plugin` | none | TUI plugin load list |
| `plugin_enabled.<id>` | boolean | plugin id keyed | `true` | Per-plugin enable override; merged with runtime KV state |

On Windows, `terminal_suspend` resolves to `none` and `input_undo` gains
`ctrl+z` (platform adaptation during resolve).

### Instruction file hierarchy

Global: `$XDG_CONFIG_HOME/opencode/AGENTS.md`, then `~/.claude/CLAUDE.md`
(unless disabled). Project: `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md` (deprecated)
walked from cwd to worktree root. Config `instructions[]` entries resolve as
paths/globs (from cwd) or URLs.

### Environment variables

| Variable | Effect | Default |
|---|---|---|
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` | Base directories for config/data/cache/state | XDG defaults |
| `OPENCODE_CONFIG_DIR` | Replace global config dir (also adds it as resource dir) | — |
| `OPENCODE_CONFIG` | Extra explicit config file (merged after global) | — |
| `OPENCODE_CONFIG_CONTENT` | Inline config text (merged as local scope) | — |
| `OPENCODE_TUI_CONFIG` | Explicit TUI config file | — |
| `OPENCODE_PERMISSION` | JSON permission object merged over file permission | — |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | Skip project config documents, `.opencode` dirs, project instruction walk | `false` |
| `OPENCODE_LOG_LEVEL` | Minimum log level (`DEBUG`,`INFO`,`WARN`,`ERROR`) | `INFO` |
| `OPENCODE_PRINT_LOGS` | `1` also logs to stderr | off |
| `OPENCODE_PURE` | Run without external plugins | `false` |
| `OPENCODE_CLIENT` | Client identifier for telemetry | `cli` |
| `OPENCODE_AUTO_SHARE` | Auto-share new sessions (runtime flag) | `false` |
| `OPENCODE_DISABLE_AUTOUPDATE` | Disable auto-update | `false` |
| `OPENCODE_ALWAYS_NOTIFY_UPDATE` | Always show update notifications | `false` |
| `OPENCODE_DISABLE_AUTOCOMPACT` | Force `compaction.auto: false` | `false` |
| `OPENCODE_DISABLE_PRUNE` | Force `compaction.prune: false` | `false` |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS` | Skip built-in plugin registration | `false` |
| `OPENCODE_DISABLE_EMBEDDED_WEB_UI` | Skip embedded web UI serving | `false` |
| `OPENCODE_DISABLE_EXTERNAL_SKILLS` | Skip `.claude`/`.agents` skill dirs | `false` |
| `OPENCODE_DISABLE_LSP_DOWNLOAD` | Skip LSP binary downloads | `false` |
| `OPENCODE_DISABLE_CLAUDE_CODE` / `_PROMPT` / `_SKILLS` | Disable CLAUDE.md prompt and/or skill interop | `false` |
| `OPENCODE_EXPERIMENTAL` | Master switch for `*_WORKSPACES`-style flags below | `false` |
| `OPENCODE_EXPERIMENTAL_REFERENCES` | Enable references feature | with master |
| `OPENCODE_EXPERIMENTAL_WORKSPACES` | Enable workspaces | with master |
| `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` | Background subagents | with master |
| `OPENCODE_EXPERIMENTAL_LSP_TOOL` / `_LSP_TY` / `_OXFMT` / `_PLAN_MODE` / `_CODE_MODE` / `_EVENT_SYSTEM` / `_ICON_DISCOVERY` | Feature gates | with master (some direct) |
| `OPENCODE_EXPERIMENTAL_NATIVE_LLM`, `OPENCODE_EXPERIMENTAL_WEBSOCKETS`, `OPENCODE_EXPERIMENTAL_FILEWATCHER`, `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER` | Direct experimental gates | `false` |
| `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` | Positive int output token cap | unset |
| `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` | Positive int bash timeout | unset |
| `OPENCODE_EXPERIMENTAL_EXA` / `OPENCODE_ENABLE_EXA` | Enable Exa websearch | `false` |
| `OPENCODE_ENABLE_PARALLEL` / `OPENCODE_EXPERIMENTAL_PARALLEL` | Enable Parallel provider | `false` |
| `OPENCODE_ENABLE_EXPERIMENTAL_MODELS` | Show experimental models | `false` |
| `OPENCODE_ENABLE_QUESTION_TOOL` | Enable question tool | `false` |
| `OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT` | Disable copy-on-select | `true` on Windows |
| `OPENCODE_DISABLE_TERMINAL_TITLE` | Disable terminal title updates | `false` |
| `OPENCODE_DISABLE_MOUSE` | Disable mouse capture | `false` |
| `OPENCODE_DISABLE_FFF` | Disable FFF filesystem | `true` on Windows |
| `OPENCODE_DISABLE_MODELS_FETCH` | Never fetch models.dev catalog | `false` |
| `OPENCODE_MODELS_URL` | models.dev catalog base | `https://models.opencode.ai` |
| `OPENCODE_MODELS_PATH` | Load catalog from file instead of cache | — |
| `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | Basic-auth credentials for serve/attach | `opencode` / none |
| `OPENCODE_GIT_BASH_PATH` | Git bash executable (Windows) | — |
| `OPENCODE_DB` | Database file override | default path |
| `OPENCODE_WORKSPACE_ID` | Workspace identity for placement | — |
| `OPENCODE_DISABLE_SHARE` | Disable sharing entirely | off |
| `OPENCODE_WEBSEARCH_PROVIDER` | `exa` \| `parallel` override | auto |
| `OPENCODE_AUTO_HEAP_SNAPSHOT` | Heap snapshot on OOM | `false` |
| `OPENCODE_SHOW_TTFD` | Show TTFD metric | `false` |
| `OPENCODE_FAKE_VCS` | Fake VCS info | — |
| `OPENCODE_CONSOLE_TOKEN` | Console auth token (set from active org) | — |
| `OPENCODE_AUTH_CONTENT` | Inline auth JSON (replaces `auth.json`) | — |
| `OPENCODE_ACP_PROFILE` | ACP profiling (`1`) | off |
| `OPENCODE_DIRECT_TRACE` | Direct trace output (`1`) | off |
| `OPENCODE_CALLER` | Client kind (`vscode`, …) | — |
| `OPENCODE_REPO_CLONE_GITHUB_BASE_URL` | GitHub clone base override | — |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `_HEADERS` | OpenTelemetry export | — |
| `OPENCODE_TEST_HOME`, `OPENCODE_TEST_MANAGED_CONFIG_DIR` | Test overrides for home/managed dir | — |
| Provider credential vars | Per-provider `env` lists from the models.dev catalog (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_*`, `AZURE_RESOURCE_NAME`, `GOOGLE_VERTEX_*`, `CLOUDFLARE_*`, `AICORE_*`, `SNOWFLAKE_*`) | — |

### CLI flags

Global: `--print-logs`, `--log-level <DEBUG|INFO|WARN|ERROR>`, `--pure`,
`--version`, `--help`.

Network (`serve`, `web`, `acp`, and attach targets):
`--port <n>` (default 0 = random), `--hostname <h>` (default `127.0.0.1`),
`--mdns`, `--mdns-domain <d>`, `--cors <origin...>`. Explicit flags beat
`server.*` config keys, which beat defaults.

`run`/`tui`/`attach`: `-c/--continue`, `-s/--session <id>`, `--fork`,
`-m/--model <provider/model>`, `--agent <name>`, `--mini`, `--no-replay`,
`--replay-limit <n>`; `run` adds `--command <name>`, `--share`,
`--format <default|json>`, `-f/--file <path...>`, `--title`, `--attach <url>`,
`-p/--password`, `-u/--username`, `--dir <path>`, `--port <n>`,
`--variant <id>`, `--thinking`, `-i/--interactive`, `--auto`,
hidden `--yolo`/`--dangerously-skip-permissions`/`--demo`/`--replay`;
`tui` adds `--prompt`.

Other commands: `agent generate` (`--path`, `--description`,
`--mode <all|primary|subagent>`, `--permissions`, `-m/--model`), `models`
(`--verbose`, `--refresh`), `providers login` (`-p/--provider`, `-m/--method`),
`upgrade` (`-m/--method`), `uninstall` (`-c/--keep-config`, `-d/--keep-data`,
`--dry-run`, `-f/--force`), `stats` (`--days`, `--tools`, `--models`,
`--project`), `session ls` (`-n/--max-count`, `--format <table|json>`),
`export` (`--sanitize`), `github` (`--event`, `--token`), `mcp add`
(`--url`, `--env <K=V...>`, `--header <K=V...>`), `plug` (`-g/--global`,
`-f/--force`), `db` (`--format <json|tsv>`), `debug agent` (`--tool`,
`--params`), `debug ripgrep` (`--query`, `--glob`, `--limit`).

## Behavior

- R1. Config documents are discovered and merged in this order; for conflicts
  the later source wins: (a) remote config from authenticated well-known
  servers, (b) global config files (`config.json`, then `opencode.json`, then
  `opencode.jsonc`), (c) `OPENCODE_CONFIG` file, (d) project
  `opencode.json`/`opencode.jsonc` files from worktree root down to cwd,
  (e) `opencode.json`/`opencode.jsonc` in each `.opencode` directory and
  `OPENCODE_CONFIG_DIR` (in directory discovery order), (f) auto-discovered
  agents/commands/modes/plugins from those directories, (g)
  `OPENCODE_CONFIG_CONTENT`, (h) active organization console config, (i)
  managed-directory config, (j) macOS managed preferences (highest).
- R2. Merging is a deep merge; nested objects merge key-wise. Arrays replace,
  except `instructions`, which concatenates and dedupes across documents.
- R3. config-v1/variable-substitution runs before JSONC parsing:
  `{env:VAR}` becomes the variable's value (empty when unset) and `{file:path}`
  becomes the trimmed file content (`~` expanded; relative paths resolve
  against the declaring file's directory; tokens on `//` comment lines are
  left intact; a missing file is a config error, except in TUI config where it
  yields empty).
- R4. Documents are JSONC (trailing commas allowed); schema decode ignores
  unknown keys and preserves original property order (permission rule order
  is significant).
- R5. Legacy normalization applied to the merged result: `mode` entries fold
  into `agent` as `primary`; `tools` maps convert to permission rules with
  `write`/`edit`/`patch` collapsed to `edit`; explicit `permission` keys win
  over converted `tools`; `autoshare: true` without `share` sets
  `share: "auto"`; agent `maxSteps` falls back to `steps`; unknown agent keys
  fold into the agent's `options`.
- R6. `OPENCODE_PERMISSION` (JSON) merges over the file-derived `permission`;
  invalid JSON is skipped with a warning.
- R7. `username` falls back to `os.userInfo().username`, then `user`.
- R8. `OPENCODE_DISABLE_AUTOCOMPACT` forces `compaction.auto: false`;
  `OPENCODE_DISABLE_PRUNE` forces `compaction.prune: false`.
- R9. Plugin specs that look like paths resolve against the declaring config
  file's directory (never a later merge location); duplicate plugins dedupe by
  npm package name or exact file URL, keeping the winning (later) source's
  origin metadata.
- R10. Network CLI options take precedence when the flag is explicitly present
  on the command line; otherwise `server.*` config keys apply; otherwise
  defaults (`--mdns` with no configured hostname binds `0.0.0.0`). CLI `--cors`
  and config `server.cors` concatenate.
- R11. `theme`, `keybinds`, and a nested `tui` key inside `opencode.json` are
  stripped during main-config load; the TUI loader migrates them into
  `tui.json` (skipping locations where `tui.json` exists), leaving a
  `<file>.tui-migration.bak` backup.
- R12. TUI config merges: global files, then `OPENCODE_TUI_CONFIG`, then
  project `tui.json` files root-first, then `.opencode` directories; unknown
  keybind names are dropped; an invalid TUI file logs a warning and is skipped
  rather than failing startup.
- R13. `update` writes the instance config as `<instance>/config.json`;
  `updateGlobal` patches the global file in place (JSONC-aware patching for
  `.jsonc`), writing only when content changes.
- R14. Well-known remote config: for each authenticated server,
  `<origin>/.well-known/opencode` supplies `{config, remote_config}` where
  `remote_config.{url,headers}` points at a full config document; both merge
  at global scope before user global files.
- R15. Managed config: the platform managed directory
  (`/Library/Application Support/opencode`, `%ProgramData%\opencode`, or
  `/etc/opencode`) contributes `opencode.json`/`opencode.jsonc`; on macOS,
  `/Library/Managed Preferences[/user]/ai.opencode.managed.plist` (converted
  to JSON, profile metadata keys stripped) overrides all other sources.
- R16. The models.dev catalog is fetched from `OPENCODE_MODELS_URL` (cached
  5 minutes, refreshed every 60 minutes), or read from `OPENCODE_MODELS_PATH`;
  fetching is disabled by `OPENCODE_DISABLE_MODELS_FETCH`.
- R17. A model prime-time window (config-v1/prime-time) is active only when
  `primeTimeStart`, `primeTimeEnd`, and a non-empty `primeTimeDay` are all
  present on the merged model entry; otherwise the model is never blocked.
  Bounds are ISO 8601 time-of-day strings `HH:MM[:SS]` (omitted seconds
  default to `0`) with an optional zone suffix `Z`, `±HH:MM`, `±HHmm`, or
  `±HH`; a suffix-less bound denotes process-local time. Every bound is
  placed on one comparison scale — seconds-of-day on the UTC circle
  `[0, 86400)`: a local bound is rotated by the process timezone offset in
  effect at the evaluation instant, an offset bound is shifted by its offset
  (e.g. `12:00+07`–`20:00+07` is 05:00–13:00 UTC), and the result is
  normalized modulo 86400. The window matches when the process-local weekday
  of the evaluation instant is listed in `primeTimeDay` and the current
  seconds-of-day lies inside the bounds, both ends inclusive: `start <= end`
  is a single interval (`start == end` matches exactly one second-of-day);
  `start > end` crosses midnight — active from `start` to day end and from
  day start to `end`, so a full overnight span such as 22:00–06:00 needs
  both weekdays listed. Any malformed bound — a non two-digit component,
  hours > 23, minutes or seconds > 59, offset minutes > 59, or a zone suffix
  after `Z` — disables the window entirely; the model stays usable
  (fail-open). Offset hours are not range-checked and wrap through the
  modulo normalization.
- R18. On the V1 request path the three fields propagate from the config model
  entry onto the runtime model per field — the config value wins, otherwise
  the provider's existing model entry keeps its value. A request whose model
  is inside an active window fails before provider resolution,
  authentication, or any network request with the error
  `Model {providerID}/{modelID} is in prime-time ({start}–{end} on {days}) and cannot be used.`;
  the session retry policy does not classify this error as
  retryable, and it surfaces to the session processor as a terminal message
  error.

## Constraints

- All numeric bounds stated per key are enforced by schema validation; keys
  marked "unvalidated" accept any value the type allows and fail (or misbehave)
  at use time, not at load time.
- Config loading is per project instance; the global portion is cached until
  invalidated.
- Loading a project instance creates `.gitignore` inside each config directory
  (ignoring `node_modules`, package files, `.gitignore`) and installs
  `@opencode-ai/plugin` there in the background.

## Error handling

- JSONC parse failure → config error with path, line/column, and the offending
  input (fatal for the loading instance).
- Schema decode failure → config error listing per-path issues (fatal).
- Remote config fetch failure or HTML login-page response → fatal (the latter
  raises a re-auth error naming the login origin).
- Active-org remote config failure → logged and skipped (non-fatal).
- Missing `{file:}` reference → fatal config error naming the token and path
  (empty in TUI config).
- Invalid TUI config file → warning, file skipped.

## Dependencies

None. This spec is the root of the V1 configuration surface.

## Used by

- config-v2 — cites V1 key names and legacy normalization behavior as the
  migration source for the V2 surface.
- config-v2-provider-model — adopts config-v1/prime-time window semantics
  (R17) for the `ModelV2.Info` prime-time fields and resolver enforcement.
