# OpenCode V1 Integrations

Status: draft
Spec source of truth for: the implemented behavior of the V1 integration subsystems in `packages/opencode` — LSP client host, MCP client host, formatter runner, IDE detection, session sharing, git/VCS/snapshot undo machinery, worktree management, the plugin host, the ACP agent adapter, and the experimental control-plane workspaces. Module responsibilities and contracts, lifecycle, and the wiring into tools and sessions.

## Overview

These subsystems extend opencode's core session runtime with external systems.
The LSP host (`src/lsp/`) spawns language servers on demand and feeds
diagnostics and code navigation into the edit tools and the `lsp` tool. The
MCP host (`src/mcp/`) connects to Model Context Protocol servers declared in
config (stdio or HTTP), exposes their tools/prompts/resources to sessions,
and manages OAuth for remote servers. The formatter runner (`src/format/`)
probes for project-local formatters and runs them after file edits. IDE
integration (`src/ide/`) is detection plus extension install. Sharing
(`src/share/`) publishes session transcripts to a remote service. Git
(`src/git/`), VCS (`src/project/vcs.ts`), snapshot (`src/snapshot/`), and
worktree (`src/worktree/`) implement repository-aware diffs, the undo
snapshot store, and parallel workspaces. The plugin host (`src/plugin/`)
loads built-in and external Bun plugins and triggers their hooks. ACP
(`src/acp/`) adapts opencode to Agent Client Protocol clients over stdio.
The control plane (`src/control-plane/`) is the experimental multi-workspace
orchestration layer.

All of these services (except `ide/` and `git/`, which are plain modules)
are per-instance `InstanceState` services booted by `InstanceBootstrap`
(`project/bootstrap.ts`): config eager-load, plugin init (plugins may mutate
config), then LSP/share/format/vcs/snapshot/project init concurrently.

## Scope

In: `packages/opencode/src/lsp/`, `src/mcp/`, `src/format/`, `src/ide/`,
`src/share/`, `src/git/`, `src/worktree/`, `src/snapshot/`, `src/plugin/`
(host, loader, install, meta, shared, pty-environment; the built-in auth
plugins only as a load list), `src/acp/`, `src/control-plane/`, plus their
consumers where the wiring matters (`project/vcs.ts`, `project/bootstrap.ts`,
`tool/write.ts`, `tool/edit.ts`, `tool/apply_patch.ts`, `tool/read.ts`,
`tool/lsp.ts`, `session/tools.ts`, `session/system.ts`, `session/processor.ts`,
`session/revert.ts`, `session/summary.ts`, `cli/cmd/acp.ts`).

Out (non-goals): the config keys/merge pipeline that feeds `lsp`, `mcp`,
`formatter`, `plugin`, `share`, `snapshot` (owned by
[config-v1](./config-parameters.md) and [config-agents](./config-agents.md));
skill discovery and remote pull (`src/skill/` — owned by config-agents
R19–R22, not repeated here); the session/tool permission flow beyond the
integration call sites (see [core-tools-permissions](./core-tools-permissions.md));
provider/model catalog behavior; the TUI plugin loader (`kind: "tui"`)
beyond the shared resolution rules.

## Definitions

- integrations/instance-service: an Effect service whose state is built
  inside `InstanceState.make` (keyed by instance directory); disposal of the
  instance tears down servers, clients, and finalizers.
- integrations/lsp-client: one running language-server process bound to a
  `(root, serverID)` pair, owned by `LSPClient.create`.
- integrations/mcp-client: one connected MCP `Client` (SDK
  `@modelcontextprotocol/sdk`) bound to a config server name.
- integrations/snapshot-store: a dedicated git object database at
  `Global.Path.data/snapshot/<projectID>/<Hash.fast(worktree)>` used for
  undo snapshots, separate from the project's own repository.
- integrations/workspace-adapter: a control-plane plug-in implementing
  `configure/create/remove/target(/list)` for a workspace `type` (builtin
  `worktree`, or plugin-registered per project).

## Interface

### Module map — LSP, `packages/opencode/src/lsp/`

| File | Responsibility | Contract |
|---|---|---|
| `lsp.ts` | `LSP.Service`: per-instance server registry, on-demand client spawn, and the capability surface (`hover`, `definition`, `references`, `implementation`, `documentSymbol`, `workspaceSymbol`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`, `touchFile`, `diagnostics`, `hasClients`, `status`) | Registry built from config `lsp` key (R1); clients spawned lazily per file (R2); every newly spawned client publishes `LSP.Event.Updated`; scope finalizer shuts all clients down |
| `server.ts` | Built-in server descriptors: `id`, `extensions`, `root(file, ctx)` (marker-file walk), `spawn(root, ctx, flags)` returning `{process, initialization?}` or `undefined` | ~35 built-ins (R3); several may download/install their binary into `Global.Path.bin` unless `flags.disableLspDownload` |
| `client.ts` | `LSPClient.create`: jsonrpc connection over stdio (`vscode-jsonrpc`), initialize handshake, document sync, push+pull diagnostics machinery | Initialize timeout 45s; diagnostics waits R5; `notify.open` returns the new document version; `shutdown()` ends the connection and stops the process |
| `diagnostic.ts` | `Diagnostic.report(file, issues)`: render severity-1 diagnostics as a `<diagnostics>` block | Max 20 errors per file, `... and N more` suffix; empty string when no errors |
| `language.ts` | `LANGUAGE_EXTENSIONS` map (extension → LSP language id) | Unknown extensions open as `plaintext` |
| `launch.ts` | `spawn` wrapper forcing piped stdio | Throws if streams are unavailable |

### Module map — MCP, `packages/opencode/src/mcp/`

| File | Responsibility | Contract |
|---|---|---|
| `index.ts` | `MCP.Service`: per-instance client state from `cfg.mcp`, transports (stdio local / StreamableHTTP+SSE remote), statuses, tool/prompt/resource listing, `add`/`connect`/`disconnect`, OAuth orchestration | Status union `connected \| disabled \| failed \| needs_auth \| needs_client_registration`; scope finalizer SIGTERMs stdio server descendant trees and closes clients |
| `catalog.ts` | `McpCatalog`: paginated listing (tools/prompts/resources/templates), `convertTool` (MCP def → AI SDK `dynamicTool`), name sanitizing | Tool name = `sanitize(server)_sanitize(tool)`; `sanitize` replaces `[^a-zA-Z0-9_-]` with `_`; resource keys `server:uri` with `%`/`:` escaping; list pagination capped at 1000 pages with duplicate-cursor detection |
| `auth.ts` | `McpAuth.Service`: OAuth token/client/state store at `Global.Path.data/mcp-auth.json` | flock-serialized JSON, mode 0600; entries keyed by server name and validated against the stored `serverUrl` |
| `oauth-provider.ts` | `McpOAuthProvider`/`McpOAuthPendingProvider`: MCP SDK `OAuthClientProvider` | Default redirect `http://127.0.0.1:19876/mcp/oauth/callback` (configurable via `oauth.callbackPort`/`redirectUri`); dynamic client registration with expiry checks |
| `oauth-callback.ts` | `McpOAuthCallback`: ephemeral local HTTP callback server | Starts on demand, stops when idle; 5-minute pending timeout; enforces `state` presence (CSRF) |
| `browser.ts` | `McpBrowser.Service`: opens the system browser via `open` | Failure publishes `MCP.Event.BrowserOpenFailed` instead of failing auth |

### Module map — format, ide, share

| File | Responsibility | Contract |
|---|---|---|
| `format/index.ts` | `Format.Service`: per-instance formatter registry from config `formatter`, `status()`, `file(path)` | `file` returns `true` when at least one formatter ran; probe results cached per instance; failures logged, never thrown |
| `format/formatter.ts` | Built-in formatter descriptors: `name`, `extensions`, optional `environment`, `enabled(context)` returning argv (with `$FILE` placeholder) or `false` | 25 built-ins (R14); probing may inspect package.json/config files upward from the instance directory to the worktree |
| `ide/index.ts` | `ide()` detection, `alreadyInstalled()`, `install(ide)` | Supported: Windsurf, VSCode Insiders, VSCode, Cursor, VSCodium; install runs `<cmd> --install-extension sst-dev.opencode` |
| `share/session.ts` | `SessionShare.Service`: `create` (auto-share wrapper), `share`, `unshare` | `share` refuses when config `share === "disabled"`; auto-share when `flags.autoShare \|\| config.share === "auto"` and the session has no parent |
| `share/share-next.ts` | `ShareNext.Service`: remote share create/remove/sync against the share backend | Two APIs (R18); event-driven incremental sync with a 1s-delayed flush; secrets persisted in `SessionShareTable` |

### Module map — git, snapshot, worktree

| File | Responsibility | Contract |
|---|---|---|
| `git/index.ts` | `Git.Service`: git CLI wrapper (`run`, `branch`, `prefix`, `defaultBranch`, `hasHead`, `mergeBase`, `show`, `status`, `diff`, `stats`, `patch`, `patchAll`, `patchUntracked`, `statUntracked`, `applyPatch`) | Every invocation carries `-c` safety flags (no optional locks, autocrlf/fsmonitor off, longpaths/symlinks/quotepath); `run` never throws — spawn failures become exit-code-1 results; porcelain output parsed NUL-separated |
| `snapshot/index.ts` | `Snapshot.Service`: undo snapshot store (`track`, `patch`, `restore`, `revert`, `diff`, `diffFull`, `cleanup`) | Own git dir (R21); `track` returns a tree hash; all operations serialized by a per-gitdir semaphore; hourly `gc --prune=7.days` fiber |
| `worktree/index.ts` | `Worktree.Service`: parallel workspaces under `Global.Path.data/worktree/<projectID>/` (`create`, `list`, `remove`, `reset`, `makeWorktreeInfo`, `createFromInfo`) | Git-only (`NotGitError` otherwise); emits `Worktree.Event.Ready/Failed` on the global bus; `remove` disposes the booted instance first |

### Module map — plugin, acp, control-plane

| File | Responsibility | Contract |
|---|---|---|
| `plugin/index.ts` | `Plugin.Service`: per-instance hook registry — internal auth plugins, external plugin modules, `trigger`, `list`, `init` | Hook execution sequential and order-stable; every instance event fans out to `event` hooks; finalizers run `dispose` hooks |
| `plugin/loader.ts` | `PluginLoader`: plan → resolve → entrypoint → compatibility → import pipeline for `server`/`tui` kinds | Deprecated npm plugin packages silently skipped; file plugins with retryable setup failures retried once after dependency install completes |
| `plugin/shared.ts` | Spec parsing (`npm-package-arg`), file/npm source split, entrypoint resolution (`exports["./server"]` / `main` / index files), `engines.opencode` semver check, `readV1Plugin` module-shape validation | Entry points must stay inside the plugin directory; npm plugins without an explicit id use `package.json` name; path plugins must export `id` |
| `plugin/install.ts` | CLI install path: `installPlugin`, `readPluginManifest` (server/tui targets), `patchPluginConfig` (JSONC-aware edits under flock) | Server target from `exports["./server"]` or `main`; tui target from `exports["./tui"]` or an `oc-themes` field; dedupe by package name |
| `plugin/meta.ts` | `plugin-meta.json` state store (`touch`, `touchMany`, `setTheme`, `list`) | Tracks first/updated/same fingerprints (target+mtime for file, target+requested+version for npm), load counts, themes |
| `plugin/pty-environment.ts` | `PtyEnvironment` layer triggering the `shell.env` hook per directory | Provides the instance for the directory, then merges hook output as PTY env |
| `acp/agent.ts` | `Agent` implementing the ACP SDK `ACPAgent` over `ACPService.Interface`; `ACP.init({sdk}).create(connection)` | Effects mapped to `RequestError` via `ACPError.toRequestError` |
| `acp/service.ts` | Session/config orchestration: `initialize`, `authenticate`, session lifecycle, `prompt`, `cancel`, model/mode/config-option mutation, client-MCP registration, message replay | Runs against an SDK v2 HTTP client of the local server (R27) |
| `acp/directory.ts` | Per-cwd `Snapshot` of providers/models/modes/commands/default model (via `InstanceStore`/`InstanceBootstrap`) | Refreshable; backs config-option building |
| `acp/session.ts`, `content.ts`, `tool.ts`, `event.ts`, `permission.ts`, `usage.ts`, `config-option.ts`, `error.ts`, `profile.ts` | Session state, content-block↔part conversion, tool-call update builders, event subscription/streaming, permission bridging, usage accounting, config-option schemas, typed errors, `OPENCODE_ACP_PROFILE` stderr timings | See R26–R29 |
| `control-plane/types.ts` | `WorkspaceInfo`/`WorkspaceAdapter`/`Target` schemas and contracts | `configure/create/remove/target(/list)`; target is `local` directory or `remote` URL+headers |
| `control-plane/adapters/index.ts` | Adapter registry: builtin `worktree` + per-project plugin registrations (`registerAdapter`) | Lookup throws `Unknown workspace adapter` for unknown types |
| `control-plane/adapters/worktree.ts` | Worktree adapter wrapping `Worktree.Service` lazily | Requires an instance context; always a `local` target |
| `control-plane/workspace.ts` | `Workspace.Service`: workspace CRUD (`create`, `list`, `get`, `remove`, `syncList`), remote sync loops, `sessionWarp`, `waitForSync` fence, `status` | Everything except `get`/`remove` is gated by `flags.experimentalWorkspaces` |
| `control-plane/workspace-adapter-runtime.ts`, `workspace-context.ts`, `util.ts` | Effect bridges for adapter calls (with `InstanceRef`/`WorkspaceRef` context), ambient workspace-id context, `waitEvent` global-bus primitive | — |

## Behavior

### LSP

- R1. Server registry (`LSP.state`, `lsp/lsp.ts`): config `lsp` key —
  absent/`false` → no servers ("all LSPs are disabled"); `true` → all
  built-ins from `server.ts`; an object → starts from all built-ins, then
  per entry: `disabled: true` removes it (built-in or not), otherwise the
  entry overrides/adds a custom server with `command`, `env`, `extensions`,
  and `initialization` (custom entries keep the built-in `root` when the
  name matches, else root defaults to the instance directory). The
  experimental `ty`/`pyright` pair is mutually exclusive: exactly one is
  kept, selected by `flags.experimentalLspTy`
  (`OPENCODE_EXPERIMENTAL_LSP_TY`).
- R2. Client lifecycle: clients are spawned lazily by the first operation
  touching a matching file (`getClients`). A server matches when the file
  extension (or the whole name for extensionless files, e.g. `Dockerfile`)
  is in `server.extensions` and `server.root(file, ctx)` returns a root
  within the instance (`containsPath` guard). One client per
  `(root, serverID)`; concurrent spawns coalesce through an in-flight map;
  failed spawns mark `root+serverID` broken (never retried this instance);
  a scope finalizer shuts every client down on instance disposal.
- R3. Built-in servers (all in `server.ts`): typescript (requires a
  locally resolvable `typescript` package plus `typescript-language-server`
  via `Npm.which`; passes the tsserver path in `initialization`), deno
  (requires `deno.json[c]` root), vue, eslint (runs the vscode-eslint
  server; downloads the GitHub main-branch zip into `Global.Path.bin`,
  `npm install` + `compile` on first use), oxlint (prefers an `oxlint`
  binary whose `--help` advertises `--lsp`, else `oxc_language_server`),
  biome, gopls (`go install` fallback), ruby-lsp (rubocop, `gem install`
  fallback), ty (flag-gated), pyright, elixir-ls (zip download + mix
  build), zls (GitHub release asset), csharp/razor (Roslyn language server
  via `dotnet tool install`; razor additionally locates the vscode C#
  extension), fsharp (fsautocomplete), sourcekit-lsp (`xcrun --find`
  fallback), rust (rust-analyzer; root walks up to the `[workspace]`
  Cargo.toml, stopping above the worktree), clangd (release-asset download
  with symlink), svelte, astro (requires local typescript tsdk), jdtls
  (Java ≥21; eclipse snapshot tarball; Gradle settings/wrapper, Maven
  `<module>` chain, or Eclipse project root detection), kotlin-ls (JetBrains
  release CDN), yaml-ls, lua-ls (LuaLS release with meta files), php
  intelephense, prisma, dart, ocaml-lsp, bash (root = instance dir),
  terraform-ls, texlab, dockerfile, gleam, clojure-lsp, nixd (flake.nix →
  git/worktree root → instance dir), tinymist, haskell-language-server,
  julials. All downloads are suppressed when
  `flags.disableLspDownload` (`OPENCODE_DISABLE_LSP_DOWNLOAD`) is set —
  servers whose binary is missing then report "not spawnable" (broken).
- R4. Root detection helpers: `NearestRoot(markers, excludes?)` walks up
  from the file's directory to the instance directory looking for marker
  files (falls back to the instance directory); `StrictNearestRoot` returns
  `undefined` instead of falling back. JS servers key on lockfiles
  (package-lock/bun.lock(b)/pnpm-lock/yarn.lock).
- R5. Client protocol (`lsp/client.ts`): `initialize` declares client
  capabilities — workspace configuration + watched-files dynamic
  registration, textDocument didOpen/didChange, diagnostic dynamic
  registration with related-document support, no diagnostic refresh
  support; `initialize` times out after 45s (`InitializeError` marks the
  server broken). Server requests handled: `workspace/configuration`
  (answered from the server's `initialization` options by section),
  `client/register(unregister)Capability` (tracked only for
  `textDocument/diagnostic`, with `workspaceDiagnostics` distinguishing
  workspace pulls), `workspace/workspaceFolders` (the single root),
  `window/workDoneProgress/create` (null), `workspace/diagnostic/refresh`
  (null).
- R6. Document sync: `notify.open` reads the file from disk, picks the
  language id from `LANGUAGE_EXTENSIONS` (fallback `plaintext`), and sends
  `textDocument/didOpen` (version 0) preceded by a
  `workspace/didChangeWatchedFiles` create notification; a repeat open
  sends a change notification (watched-file "changed" + `didChange` with
  full text, or a full-range incremental replacement when the server's
  sync kind is incremental) and bumps the version. Diagnostics are not
  cleared on re-open (clangd re-emits only on real content change).
- R7. Diagnostics model: push (`textDocument/publishDiagnostics`, recorded
  with timestamp/version) and pull (`textDocument/diagnostic` per
  identifier and `workspace/diagnostic`, 3s request timeout) are merged
  per file with JSON-key dedupe. `waitForDiagnostics` "document" mode
  (5s budget) resolves when any pull produced items for the file or a
  fresh push arrives (150ms debounce); "full" mode (10s budget) also waits
  for workspace pulls. Identifier pulls run in parallel and unblock as
  soon as one batch yields current-file diagnostics (latency-critical,
  PR #23771). TypeScript's aggressive first push is seeded directly into
  the push cache.
- R8. Tool integration:
  - `tool/lsp.ts` exposes a single `lsp` tool with nine operations
    (`goToDefinition`, `findReferences`, `hover`, `documentSymbol`,
    `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`,
    `incomingCalls`, `outgoingCalls`); 1-based line/character input is
    converted to 0-based; asks the `lsp` permission with `["*"]` patterns;
    touches the file ("document" diagnostics) before querying; results are
    JSON-stringified into tool output. `workspaceSymbol` filters to
    code-ish symbol kinds and caps at 10 per server.
  - `tool/write.ts`, `tool/edit.ts`, `tool/apply_patch.ts` call
    `touchFile(file, "document")` after writing, then `diagnostics()` and
    append `<diagnostics>` blocks for the edited file (and up to
    `MAX_PROJECT_DIAGNOSTICS_FILES` other files) to the tool output,
    prompting the model to fix errors.
  - `tool/read.ts` forks a plain `touchFile` (no diagnostic wait) so the
    server warms up.
  - `session/prompt.ts` uses `documentSymbol` to attach file outlines to
    file-attachment context parts.
- R9. `status()` lists one entry per live client (`connected` only); the
  schema allows `error` but the implementation never produces it — broken
  or spawning servers are invisible (D1).

### MCP

- R10. Discovery (`MCP.state`, `mcp/index.ts`): every entry of the merged
  config `mcp` map is connected at instance boot, concurrently. Entries
  without a `type` field are logged as errors and skipped;
  `enabled: false` yields a `disabled` status without connecting. The
  runtime-added servers (`add`, e.g. from the ACP flow) live in the state
  alongside config entries.
- R11. Local transport (`type: "local"`): `StdioClientTransport` spawning
  `command[0]` with the rest as args, cwd resolved against the instance
  directory (`cwd` config honored), environment = `process.env` + entry
  `environment` (+ `BUN_BE_BUN=1` when the command is `opencode` itself).
  Connect timeout is `timeout` config or 30s default.
- R12. Remote transport (`type: "remote"`): URL is parsed (invalid URL →
  `failed`); `StreamableHTTPClientTransport` is tried first, then
  `SSEClientTransport`, both with config `headers` and an OAuth provider
  unless `oauth: false`. `UnauthorizedError` (or an OAuth-flavored
  message) stops the fallback chain: a registration/client_id failure
  yields `needs_client_registration` (toast: add `clientId` to config),
  otherwise the transport is parked in a pending map and status becomes
  `needs_auth` (toast: `opencode mcp auth <name>`). Both transports also
  honor `oauth: {clientId, clientSecret, scope, callbackPort,
  redirectUri}`.
- R13. After connecting, servers advertising the `tools` capability get
  their tool defs listed (R14 pagination); server `instructions` are
  captured. Watchers: `onclose` flips the status to `failed`
  ("Connection closed") and publishes `MCP.Event.ToolsChanged`;
  `tools/list_changed` re-lists and re-publishes; log notifications map to
  leveled Effect logs. The client answers `roots/list` with the instance
  directory. Client capabilities advertised: `roots` only — sampling,
  elicitation, and tasks are deliberately disabled (issue links in
  `CLIENT_OPTIONS`).
- R14. Catalog (`mcp/catalog.ts`): all list calls paginate with
  cursor-loop protection (≤1000 pages, duplicate cursors fail);
  `listTools` retries once without `outputSchema` validation when the
  server's tool schemas fail SDK validation. `convertTool` wraps
  `client.callTool` with `resetTimeoutOnProgress`, an abort signal, the
  resolved timeout, and a no-op `onprogress` (enables timeout resets);
  `isError` results throw with the joined text content; a server returning
  only `structuredContent` gets it JSON-stringified into a text block.
- R15. Exposure to sessions (`session/tools.ts`): unless
  `flags.experimentalCodeMode`, every cached tool def becomes an AI SDK
  tool named `<server>_<tool>` (sanitized). Execution wraps
  `tool.execute.before`/`after` plugin triggers, a permission ask keyed by
  the full tool name (patterns `["*"]`), and content mapping — text is
  joined, images and `resource` blobs become file attachments (unsupported
  MIME types and blobs over 10MB are omitted with an explanatory note),
  output truncation via `truncate.output`. In code mode the registry
  instead exposes one catalog tool describing servers and tool names
  (`tool/code-mode.ts` / `registry.ts`).
- R16. Resources: sessions additionally get `list_mcp_resources`,
  `list_mcp_resource_templates`, and `read_mcp_resource` tools, created
  only when at least one connected server advertises the `resources`
  capability; resource reads are bounded and permission-checked with
  `mcp:<server>:*` patterns. `MCP.prompts()` feeds slash commands (see
  config-agents R23). `MCP.instructions()` feeds the
  `<mcp_instructions>` block of the system prompt, filtered to servers
  whose tools are visible to the agent's permission ruleset
  (`session/system.ts`).
- R17. Timeouts: per-call timeout resolves as
  `runtime-added config timeout ?? static config timeout ??
  experimental.mcp_timeout ?? (list/default 30s)`.
- R18. OAuth flow: `startAuth` spins up the local callback server
  (default `127.0.0.1:19876/mcp/oauth/callback`, overridable), stores a
  random 32-byte `state`, and connects a pending transport with a
  `McpOAuthPendingProvider`; on `UnauthorizedError` the captured
  authorization URL is returned. `authenticate` opens the browser (or
  publishes `BrowserOpenFailed`), awaits the callback, verifies the state
  (mismatch → CSRF error), and finishes via `finishAuth`, which redeems
  the code on the parked transport, commits tokens via `McpAuth`, and
  reconnects. Tokens/client info/code verifiers persist per server name in
  `Global.Path.data/mcp-auth.json` (0600, flock); `getForUrl` invalidates
  credentials when the configured URL changed. `removeAuth` deletes
  stored tokens and cancels pending callbacks.
- R19. Disposal: the instance finalizer walks stdio client process trees
  (`pgrep -P` BFS; no-op on Windows), SIGTERMs descendants, closes
  clients, and clears pending OAuth transports.

### Formatter

- R20. Registry (`Format.state`): config `formatter` key — absent/`false`
  → no formatters; `true` → all built-ins; an object → per name:
  `disabled: true` removes it; otherwise the entry deep-merges over the
  built-in (or a bare `{extensions: []}` shell for unknown names), with a
  configured `command` replacing the built-in probe entirely (no
  `command` and no built-in → never enabled). `ruff` and `uv` are linked:
  disabling either removes both.
- R21. Probing: `enabled(context)` returns the argv to run (with `$FILE`)
  or `false`. Most built-ins probe `which()`; JS-family ones
  (prettier/oxfmt/biome) require the dependency in a `package.json`
  between the instance directory and worktree plus an `Npm.which`
  binary; ruff requires config markers or a ruff mention in dependency
  files; uv only when ruff is absent and `uv format` is supported;
  clang-format/ocamlformat/pint require their config/manifest markers;
  `oxfmt` is gated by `flags.experimentalOxfmt`. Probe results are cached
  per instance.
- R22. `Format.file(filepath)`: collects every formatter whose extension
  list matches, runs each sequentially (cwd = instance directory, env =
  `item.environment` merged over the process env, stdio ignored), logs
  spawn/exit failures, and returns `true` iff at least one formatter
  matched (regardless of exit code). Callers: `write`/`edit`/`apply_patch`
  run it after persisting the edit (then re-sync the BOM, since
  formatters may rewrite the file); the HTTP `formatter` endpoint exposes
  `status()`.

### IDE

- R23. Detection (`ide()`): `TERM_PROGRAM=vscode` plus a `GIT_ASKPASS`
  containing a known IDE name (Windsurf, VSCode Insiders, VSCode, Cursor,
  VSCodium) → that name; otherwise `"unknown"`. `alreadyInstalled()` is
  true when `OPENCODE_CALLER` is `vscode`/`vscode-insiders`. `install()`
  runs the IDE CLI with `--install-extension sst-dev.opencode`;
  "already installed" stdout raises `AlreadyInstalledError`, nonzero exit
  raises `InstallFailedError`. Consumed by the TUI run footer to offer the
  extension.

### Share

- R24. `SessionShare.create` wraps `session.create`: parent sessions are
  never auto-shared; otherwise sharing fires in the background when
  `flags.autoShare` (`OPENCODE_AUTO_SHARE`) or config `share === "auto"`.
  `share` throws when config `share === "disabled"`; it calls
  `ShareNext.create`, persists the URL on the session (`setShare`), and
  `unshare` removes both. `OPENCODE_DISABLE_SHARE=true|1` short-circuits
  the entire backend (create returns a dummy share).
- R25. Backend selection (`ShareNext.request`): an authenticated account
  with an active organization uses the console API (`/api/shares`) with
  bearer token and `x-org-id` headers against the account URL; otherwise
  the legacy API (`/api/share`) against `enterprise.url` or
  `https://opncd.ai`, unauthenticated.
- R26. Sync model: create POSTs `{sessionID}`, stores `{id, secret, url}`
  in `SessionShareTable` (upsert by session), caches it, and forks a full
  sync (session info + all messages + parts + session diff + the distinct
  user-message models). Thereafter, instance-scoped listeners on
  `session.updated`, `message.updated` (user messages also sync their
  model), `message.part.updated`, `session.diff`, and `session.deleted`
  enqueue deduplicated records (map keyed by `session`, `message/<id>`,
  `part/<mid>/<pid>`, `session_diff`, `model`) and a flush fiber POSTs the
  batch to `/sync` with the secret after a 1s coalescing delay; HTTP ≥400
  is logged as a warning and the batch is dropped. Un-share deletes the
  remote share, the table row, and any queued data. Privacy surface: the
  synced payload is the transcript (messages/parts), session metadata,
  model identities, and working-tree diffs; the share `secret` lives only
  in the local database and the sync request body.

### Git, VCS, snapshot, worktree

- R27. `Git.Service` is a stateless CLI wrapper: every command runs with
  `-c core.autocrlf=false -c core.fsmonitor=false -c core.longpaths=true
  -c core.symlinks=true -c core.quotepath=false --no-optional-locks`;
  spawn errors become synthetic failed results (never throws).
  `defaultBranch` resolves: primary remote (`origin`, sole remote, else
  `upstream`, else first) → its `refs/remotes/<remote>/HEAD` → configured
  `init.defaultBranch` if it exists → `main` → `master`. Patch calls take
  `maxOutputBytes`; on truncation the single-file `patch`/`patchUntracked`
  return empty text with `truncated: true` while `patchAll` keeps the
  text. `applyPatch` streams the patch via stdin.
- R28. `Vcs.Service` (`project/vcs.ts`), instance-scoped: resolves the
  current branch and default branch at init and re-resolves the branch
  whenever a watched `HEAD` file event lands (publishing
  `Vcs.Event.BranchUpdated`). `diff("git")` diffs against `HEAD` (or
  plain status when there is no HEAD); `diff("branch")` diffs against the
  merge-base with the default branch and is empty when currently on it.
  Diffs include untracked files, cap patch bytes (10MB per file and
  total, degrading to empty patches when capped), batch via `patchAll`
  with per-file fallback. `diffRaw` produces a raw apply-able patch
  (tracked + untracked); `apply` runs `git apply -` and fails with
  `PatchApplyError` (`non-git`/`not-clean`). Non-git projects return
  empty results throughout.
- R29. Snapshot store (`snapshot/index.ts`): a private git dir at
  `Global.Path.data/snapshot/<projectID>/<Hash.fast(worktree)>`, enabled
  only for git projects with config `snapshot !== false`. On first use it
  is `git init`-ed with tuned config (autocrlf false, manyFiles,
  index.version 4, untracked cache, fsmonitor off) and seeded from the
  source repository — the source `objects` dir (plus live alternates) is
  chained via `objects/info/alternates` and the source index copied, so
  staging reuses existing object hashes instead of re-hashing large
  checkouts.
- R30. `track()`: mirrors the repo's `info/exclude` into the snapshot
  gitdir, lists changed (diff-files) and untracked (ls-files --others)
  paths, resolves the source repo's ignore rules against exactly those
  candidates (`check-ignore --no-index --stdin`, with `./` prefix
  protection for colon-leading paths), drops newly ignored files from the
  index (`rm --cached`), excludes untracked files larger than 2MB (added
  to the snapshot exclude as a blocklist), stages the remainder via
  top-level literal pathspecs, and returns `write-tree`'s hash. All
  snapshot operations run under a per-gitdir semaphore.
- R31. `patch(hash)` lists files differing from the staged state vs
  `hash` (hiding ignored-file removals); `restore(tree)` runs `read-tree`
  + `checkout-index -a -f`; `revert(patches)` checks out files from their
  snapshot trees and deletes files absent there — batched up to 100
  adjacent same-hash, non-path-clashing files with an `ls-tree`
  precheck and single-file fallback; `diff(hash)` returns the cached diff
  text; `diffFull(from, to)` builds `FileDiff[]` (status + numstat +
  full-context unified patch) fetching content in batches via
  `git cat-file --batch` with per-file `git show` fallback. A background
  fiber runs `git gc --prune=7.days` hourly after a 1-minute delay.
- R32. Session undo wiring: `session/processor.ts` tracks a snapshot at
  each `step-start` (recording the hash on the part), tracks again at
  `step-finish`, and emits a `patch` part with the files changed during
  the step. `session/revert.ts` implements revert-to-message: it restores
  the pre-revert snapshot tree, reverts the accumulated patch parts,
  records a fresh `track()` as the revert snapshot plus its diff summary,
  and (after confirmation) deletes the reverted messages/parts;
  `unrevert` restores the snapshot. `session/summary.ts` computes
  per-message diffs via `diffFull` between step boundaries; share sync
  consumes those diffs.
- R33. Worktrees (`worktree/index.ts`): `create` allocates
  `Global.Path.data/worktree/<projectID>/<slug>` (26 uniqueness attempts,
  appending random slugs; explicit names are slugified) with branch
  `opencode/<name>` (or detached HEAD), then `git worktree add
  --no-checkout` and `project.addSandbox`. Boot (`createFromInfo`)
  populates with `git reset --hard`, loads a full instance through
  `InstanceStore` (config/agents/plugins/etc. for the new directory),
  emits `Worktree.Event.Ready`/`Failed` on the global bus, then runs the
  project's start command and the optional extra `startCommand` (shell:
  `bash -lc` / `cmd /c`). `list` parses `worktree list --porcelain`
  excluding the primary workspace. `remove` disposes the instance,
  stops fsmonitor, forces worktree removal (tolerating an already-gone
  entry), cleans the directory with retries (50 on Windows), and deletes
  the branch. `reset` refuses the primary workspace, fetches the default
  branch when remote-tracking, hard-resets to it, cleans (`-ffdx` with a
  prune-and-retry pass for locked files), updates/resets/cleans
  submodules, verifies a clean status, and re-runs start scripts.

### Plugin host

- R34. Load list (`plugin/index.ts`): internal plugins load first unless
  `flags.disableDefaultPlugins` — CodexAuth (with experimental WebSocket
  rollout: enabled by `flags.experimentalWebSockets` or a local/dev/beta
  installation channel), CopilotAuth, Modal, GitlabAuth, PoeAuth,
  CloudflareWorkersAuth, CloudflareAIGatewayAuth, AzureAuth,
  DigitalOceanAuth, SnowflakeCortexAuth, XaiAuth, Cerebras. External
  plugins come from the merged `plugin_origins` (deduplicated spec list
  tracked by config; see config-agents R2/R6) unless `flags.pure`
  (`OPENCODE_PURE`), which loads none; loading external plugins first
  joins the background `@opencode-ai/plugin` dependency installs
  (`Config.waitForDependencies`).
- R35. Plugin input: an SDK client bound to the local server URL (or an
  in-process fetch against the app when no URL is exposed),
  `project`/`worktree`/`directory`, `serverUrl`, `Bun.$` when running
  under Bun, and `experimental_workspace.register(type, adapter)` which
  forwards to the control-plane adapter registry scoped to the project
  (global registration uses `ProjectV2.ID.global`).
- R36. Module shapes: a V1 plugin default-exports `{id?, server(input,
  options)}` (path plugins must export `id`; npm plugins fall back to
  their package name); `server` and `tui` are mutually exclusive. Legacy
  modules — any exported function, or `{server: fn}` — are still
  accepted; each distinct function is invoked as a plugin. After all
  plugins load, each registered hooks object receives the `config` hook
  with the merged config.
- R37. Loader pipeline (`plugin/loader.ts` + `shared.ts`): spec parsing
  via `npm-package-arg` (aliases resolved; bare names get `@latest`);
  `file://`/relative/absolute specs resolve against disk (directory with
  `package.json` or index file), npm specs install via `Npm.add`;
  entrypoints come from `exports["./server"]` (or `main` for server
  kind; index files for file plugins) and must resolve inside the plugin
  directory; npm plugins declare compatibility via
  `engines.opencode` (skipped for 0.x/dev builds and file plugins);
  deprecated packages (`opencode-openai-codex-auth`,
  `opencode-copilot-auth`) are silently skipped as built-in now. Import
  runs after all validation; a file plugin whose install-stage setup
  failed retryably ("missing package.json or index file") is retried
  once after dependency installs complete — post-import failures are
  permanent for the process (Bun caches failed module resolution).
- R38. Failure reporting: install-stage failures publish a session error
  event ("Failed to install plugin pkg@version"), compatibility skips
  and entry/load failures publish session errors; a plugin whose
  `server()` throws is logged and skipped. Individual hook failures
  never fail the caller: `trigger` awaits each hook sequentially,
  mutating the shared `output` object; `event` hooks are fire-and-forget
  per event (filtered to the instance directory); `dispose` hooks run at
  instance disposal with errors logged.
- R39. Hook surface (`packages/plugin/src/index.ts` `Hooks`): `dispose`,
  `event`, `config`, `tool` (tool map), `auth` (provider auth methods
  with oauth/api prompts), `provider` (model augmentation), trigger
  hooks `chat.message`, `chat.params`, `chat.headers`,
  `permission.ask`, `command.execute.before`,
  `tool.execute.before`/`after`, `shell.env`, `tool.definition`, and the
  `experimental.*` family (`chat.messages.transform`,
  `chat.system.transform`, `provider.small_model`,
  `session.compacting`, `compaction.autocontinue`, `text.complete`).
  All trigger hooks share the `(input, output) => Promise<void>` mutate-
  output contract that `Plugin.trigger` implements.
- R40. `plugin/install.ts` implements the CLI flow (`opencode plug
  install`): resolve the target, read the manifest for targets (server
  from `exports`/`main`; tui from `exports` or `oc-themes`), then patch
  `.opencode/opencode.json{,c}` (or `tui.json{,c}`) plugin arrays under
  a flock, deduping by package name (`force` replaces; `[spec, options]`
  tuples preserve options in `exports[./kind].config`). `plugin/meta.ts`
  maintains `plugin-meta.json` load fingerprints and themes.
  `plugin/pty-environment.ts` provides the server-side PTY environment
  by triggering `shell.env` in the file's instance.

### ACP

- R41. `opencode acp` (`cli/cmd/acp.ts`) starts the HTTP server (network
  options honored), builds an SDK v2 client against it with server auth
  headers, sets `OPENCODE_CLIENT=acp`, and serves one ACP
  `AgentSideConnection` over stdin/stdout newline-delimited JSON. All
  ACP operations are implemented as Effects against that SDK client;
  `OPENCODE_ACP_PROFILE=1` adds stderr timing marks.
- R42. `initialize` reports protocol version 1, agent "OpenCode"
  (`InstallationVersion`), capabilities: `loadSession`, MCP
  (`http`+`sse`), prompts with embedded context and images, and session
  close/fork/list/resume. The single auth method (`opencode-login`)
  describes `opencode auth login` and, when the client advertises
  `terminal-auth`, attaches the terminal command metadata.
  `authenticate` accepts that method id and returns an empty success —
  actual credentials live in the opencode server (D4).
- R43. Sessions: `newSession` snapshots the cwd's providers/models/modes/
  commands (via `InstanceStore`/`InstanceBootstrap`), picks the default
  model and variant, creates the session over the SDK (with the default
  mode when modes exist), registers client-provided MCP servers into the
  instance, and returns config options (model select, effort/variant
  select, mode select). `loadSession` additionally restores model/mode
  from message history and replays prior messages as session updates;
  `listSessions`/`resumeSession`/`closeSession`/`forkSession` map onto
  the SDK. `setSessionMode`/`setSessionModel`/`setSessionConfigOption`
  mutate via SDK calls and update local state.
- R44. Client MCP servers (`mcpServers` in new/load session params) are
  registered by calling the SDK `mcp.add` endpoint for the instance
  directory (`registerMcpServers`): url-shaped servers become `remote`
  configs (url + headers), command-shaped ones become `local` configs
  (command + args + env). Registrations are keyed by name plus a stable
  config stringify so re-registration is idempotent within a connection's
  lifetime.
- R45. Prompting: content blocks convert to session parts (text, images,
  embedded context/resource links; `content.ts`); slash-command-shaped
  prompts route to the command system. `cancel` aborts the in-flight
  prompt. Event streaming (`event.ts`): a subscription consumes the
  global event stream and forwards `sessionUpdate` notifications —
  message parts, deltas, tool-call lifecycle (pending/running/completed/
  error with locations derived per tool kind), usage, and available
  commands; permission asks bridge to the client's `requestPermission`
  (with a fallback policy when unsupported); `runUntilIdle` keeps the
  prompt response open until the session quiets.

### Control plane (experimental workspaces)

- R46. Everything except `get`/`remove` is gated by
  `flags.experimentalWorkspaces` (`OPENCODE_EXPERIMENTAL_WORKSPACES`).
  Workspaces are persisted rows (`WorkspaceTable`) with an adapter
  `type`; adapters resolve builtin-first (`worktree`), then
  plugin-registered per-project entries.
- R47. `create`: configure the adapter (the worktree adapter allocates a
  detached worktree info), insert the row, then `adapter.create` with an
  environment carrying the auth content, the workspace id, the
  experimental flag, and OTEL settings; wait (5s) for the workspace
  status event to reach `connected` or `error`.
- R48. Remote sync: for workspaces whose target is `remote`, a per-
  workspace fiber connects an SSE stream to `<url>/global/event`, first
  replays history via `POST /sync/history` (sending per-session event
  sequence watermarks; the response replays into the local event store
  with the workspace as owner), then applies incoming `sync` events via
  `events.replay` and mirrors other events onto the GlobalBus;
  disconnections reconnect with exponential backoff capped at 2 minutes.
  Connection status transitions publish `Workspace.Event.Status`. Local
  targets are "connected" iff the directory exists.
- R49. `sessionWarp` moves a session between workspaces: cancel/claim the
  session on the source (claiming makes late source events ignored),
  optionally copy working changes (`diffRaw` from the source, `apply` on
  the target — locally or via remote HTTP `/vcs/diff/raw` and
  `/vcs/apply`), replay the session's event rows to the target
  (`/sync/replay` in batches of 10), `/sync/steal` it, then re-point the
  session's workspace. `waitForSync` fences on `EventSequenceTable`
  watermarks (5s default timeout, abortable). `syncList` reconciles
  adapter-listed workspaces into the table.

## Constraints

- All integration services are instance-scoped: server processes, MCP
  clients, plugin hooks, and sync fibers live and die with the instance
  directory's `InstanceState`; nothing survives disposal except on-disk
  artifacts (downloaded binaries, snapshot stores, `mcp-auth.json`,
  `plugin-meta.json`, share rows).
- LSP broken-server marks and spawn dedupe are keyed by `root + serverID`;
  a server that failed once in an instance is never retried until the
  instance is re-created.
- The snapshot store must never be the project repository: it is
  addressed by `--git-dir`/`--work-tree` pairs, and its `alternates`
  chain makes it dependent on the source repo's object database existing.
- MCP tool names and resource keys are lossy-sanitized; collisions after
  sanitizing are not detected.
- Remote share/sync payloads leave the machine by design; the only
  redaction is the ignored-file filtering inherited from snapshot diffs
  (R30–R32). `share: "disabled"`, `OPENCODE_DISABLE_SHARE`, and the
  absence of auto-share are the privacy controls.
- The plugin `trigger` contract mutates the caller's `output` object
  in place and returns it; hooks must not assume immutable inputs.
- Control-plane remote workspaces trust the adapter-supplied URL and
  headers; no additional authentication is layered on the sync HTTP
  calls.

## Error handling

| Condition | Behavior |
|---|---|
| LSP server binary missing / spawn fails | Server marked broken for the instance; operation returns empty results; `hasClients` false |
| LSP initialize timeout (45s) | `InitializeError`; process stopped; server broken |
| LSP capability request fails | Per-request `.catch` → null/empty; never surfaces to the model |
| MCP entry without `type` | Logged error; entry skipped |
| MCP connect failure (local/remote) | `failed` status with message; other servers unaffected |
| MCP remote requires OAuth | `needs_auth`/`needs_client_registration` status + TUI toast; connect retried via auth flow |
| MCP tool call returns `isError` | Tool execution throws with the server's text content |
| Formatter spawn/exit failure | Logged; `Format.file` still returns true; edit tools unaffected |
| Share create/sync HTTP failure | Sync batch dropped with a warning; share record retained |
| OAuth state mismatch | Error ("potential CSRF attack"); state cleared |
| Git command spawn failure | Synthetic exit-code-1 `Result`; callers see empty output |
| Snapshot staging/listing failure | Logged warning; track continues with what succeeded |
| Plugin install/entry/load failure | Session error event (or log); plugin skipped; instance continues |
| Plugin hook throws | Logged; `trigger` continues with the mutated output |
| Worktree create/remove/reset git failure | Typed `*FailedError` with stderr-derived message |
| Workspace sync HTTP failure | Status `error`, logged; reconnect loop continues with backoff |

## Divergences and open questions

- D1. `LSP.Status` schema declares `connected | error`, but `status()`
  only ever emits `connected` — broken, spawning, and disabled servers
  are invisible to clients (R9).
- D2. `plugin/index.ts` contains an empty `if (flags.pure &&
  cfg.plugin_origins?.length) {}` block — leftover of unimplemented pure-
  mode reporting.
- D3. `snapshot/index.ts` `diffFull`'s `fail()` helper returns `undefined`
  without logging the prepared message; cat-file fallbacks are silent
  (the per-file `git show` fallback still covers correctness).
- D4. `ACP.authenticate` is a stub that succeeds for the single
  well-known method id; real authentication is assumed to live in the
  server's auth store.
- D5. The ESLint LSP server downloads the `main` branch zip of
  microsoft/vscode-eslint and builds it with `npm install`/`compile` —
  un-pinned and heavyweight compared to every other server's release
  assets.
- D6. `Format.update`-style config round-trips do not exist for
  formatters; `formatter` config changes require an instance reload
  (like all config, per config-agents R25).
- D7. Control-plane remote sync endpoints (`/sync/history`,
  `/sync/replay`, `/sync/steal`, `/global/event`) are consumed here but
  their server-side counterparts are not covered by this spec; the
  remote-workspace protocol has no dedicated spec yet.
- D8. `ShareNext.create` under `OPENCODE_DISABLE_SHARE` returns a dummy
  `{id: "", url: "", secret: ""}` share rather than failing — callers
  must treat an empty URL as "not shared" (TUI does; `setShare`
  persists the empty URL on explicit share attempts).

## Dependencies

- config-agents — owns config discovery/merge feeding every subsystem's
  config keys, the `plugin`/`plugin_origins` list, MCP prompts as
  commands (R23), and skill loading (`src/skill/`, not repeated here).
- config-v1 — owns the parameter tables for `lsp`, `mcp`, `formatter`,
  `share`, `snapshot`, `plugin`, `enterprise.url`.
- core-tools-permissions — owns the ask/reply flow that the edit, lsp,
  and MCP tool call sites use.
- provider-models — owns the provider/model catalog that ACP directory
  snapshots and share model sync consume.

## Used by

- None yet. Specs covering session tool wiring, undo semantics, or the
  TUI's integration surfaces should reference this spec for module
  contracts and lifecycle.
