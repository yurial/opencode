# TUI Architecture

Status: stable
Spec source of truth for: the architecture and runtime behavior of the
opencode terminal UI — `packages/tui` launch paths, worker model, provider
composition, routes, keymap, sync contexts, and the session data flow into the
UI.

## Overview

The TUI is opencode's canonical terminal client. It is a Solid application
rendered by OpenTUI (`@opentui/core` renderer + `@opentui/solid` JSX runtime),
packaged as the private workspace package `@opencode-ai/tui`, and launched by
two thin CLI hosts: the legacy `packages/opencode` `$0`/`attach` commands and
the new `packages/cli` default command. All OpenCode domain state and actions
flow through the generated `@opencode-ai/sdk` client; the package never
imports backend implementation modules (`tui-package`). Plugin discovery and
loading stay host-owned; the package owns plugin presentation (slots, routes,
API surface — `tui-plugins`).

This spec fixes the architecture-level behavior: startup, renderer lifecycle,
the provider tree, routing, the keymap/command system, the client-side sync
stores (legacy and V2), the prompt submission flow, and the
permission/question interaction loop.

## Scope

In: stack and entrypoints; legacy worker model and transports; new-CLI daemon
launch; renderer creation/restoration; provider tree order and gating; routes
(`home`, `session`, plugin); dialog stack; keymap registration, mode stack,
binding groups; command palette and slash commands (inventory level); legacy
`Sync` store shape and event application; V2 `Data` store; `Local` state and
its persisted files; KV persistence; prompt submit/shell/command paths;
permission auto-reply and prompt stages; question flow; interrupt; update
flow; terminal title/selection/attention wiring; module responsibility map;
invariants and known stubs.

Out (non-goals): theme key mapping and value resolution (`tui-theme`);
thinking-mode persistence and meta-part rendering rules
(`tui-session-display`); plugin config, loading, install, and slot-mode
semantics (`tui-plugins`); the v2 command-shim removal plan
(`opencode-v2-tui-shim`); keybind config file syntax (config-v1
`keybinds.<command>`); the `--mini` interface (`packages/opencode` `run`
command — a separate renderer that shares the SDK but not this app); web and
desktop session UIs.

## Definitions

- `tui-architecture/run` — the public package entrypoint
  (`packages/tui/src/index.tsx` → `app.tsx`): `run(input: TuiInput)` is an
  `Effect` that owns the renderer, the Solid tree, and shutdown.
- `tui-architecture/worker` — the legacy backend worker thread
  (`packages/opencode/src/cli/tui/worker.ts`) hosting the embedded server,
  config, and instance runtime, bridged to the UI thread over RPC.
- `tui-architecture/transport` — the three ways the SDK reaches a server:
  in-process RPC fetch (legacy local), HTTP+SSE (legacy external/attach, new
  CLI daemon).
- `tui-architecture/sync-store` — the legacy client-side mirror of server
  state (`packages/tui/src/context/sync.tsx`), a Solid store updated by
  `GlobalEvent` events plus bootstrap fetches.
- `tui-architecture/data-store` — the V2 client-side store
  (`packages/tui/src/context/data.tsx`) keyed by session and location,
  maintained from `V2Event`s.
- `tui-architecture/mode-stack` — the keymap mode mechanism
  (`opencode.mode` data key + `createOpencodeModeStack`) with `base` default
  and pushed modes (`modal`, `autocomplete`, `question`, plugin modes).
- `tui-architecture/binding-group` — a named command group passed to
  `tuiConfig.keybinds.gather(<group>, commands)` (`app`, `app.global`,
  `app_exit`, `session`, `session.global`, `session.global.unfocused`,
  `input`).

## Interface

### Public package exports (`packages/tui/package.json`)

- `.` — `run`, `TuiInput` (`src/index.tsx`).
- `./builtins`, `./config`, `./context/*`, `./attention`, `./editor`,
  `./editor-zed`, `./runtime`, `./terminal-win32`, `./config/keybind`,
  `./keymap`, `./prompt/display`, `./plugin/runtime`, `./plugin/slots`,
  `./plugin/command-shim`, `./parsers-config`, `./util/*`, `./logo`,
  `./ui/*`, `./component/spinner`, `./component/register-spinner` — explicit
  host/plugin-contract entrypoints consumed by `packages/opencode` and
  `packages/plugin`.

### `TuiInput` (the whole host contract)

```ts
type TuiInput = {
  url: string
  args: Args // { model?, agent?, prompt?, continue?, sessionID?, fork?, auto? }
  config: TuiConfig.Resolved
  onSnapshot?: () => Promise<string[]> // app.heap_snapshot
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource // { subscribe(handler): Promise<() => void> }
  pluginHost: TuiPluginHost // { start(...), dispose() }
}
```

`run` must be executed with the core Effect layer
(`AppNodeBuilder.build(Global.node)` — provided by `packages/opencode`
`src/cli/tui/layer.ts` and `packages/cli` `src/tui.ts`).

### Hosts

| Host | File | Behavior |
|---|---|---|
| Legacy thread (`opencode [project]`, `$0`) | `packages/opencode/src/cli/cmd/tui.ts` | Spawns backend worker; RPC transport by default, HTTP when `--port`/`--hostname`/mdns given |
| Legacy attach (`opencode attach <url>`) | `packages/opencode/src/cli/cmd/attach.ts` | HTTP+SSE against a remote server with basic-auth headers |
| New CLI default command | `packages/cli/src/commands/handlers/default.ts` → `src/tui.ts` | Daemon transport (version-matched spawned `serve --register` process); resolved defaults config; no-op plugin host |

### TUI-local persistence

| File | Owner | Content |
|---|---|---|
| `<state>/kv.json` | `context/kv.tsx` | All KV flags (theme, toggles, plugin_enabled, skipped_version, …) |
| `<state>/model.json` | `context/local.tsx` | `recent` (≤10), `favorite`, per-model `variant` map |
| `<state>/session.json` | `context/local.tsx` | `pinned` session ids (quick-switch slots, ≤9) |
| `<state>/prompt-history.jsonl`, `<state>/prompt-stash.jsonl`, `<state>/frecency.jsonl` | `component/prompt/{history,stash,frecency}.tsx` (logic in `prompt/*.ts`) | Prompt history, stash, file frecency |

`<state>` comes from `TuiPathsProvider` (`global.state`), supplied by the host
layer.

## Configuration

The package consumes only `TuiConfig.Resolved`
(`packages/tui/src/config/index.tsx`): schema for `tui.json` keys (`theme`,
`keybinds`, `plugin`, `plugin_enabled`, `leader_timeout`, `attention`,
`prompt.max_width/max_height`, `scroll_speed`, `scroll_acceleration`,
`diff_style`, `cursor`, `mouse`) plus pure `resolve()` (defaults:
`leader_timeout` 2000, `mouse` true, attention volume 0.4, pack
`opencode.default`). File discovery, precedence, JSONC, migration, and
substitutions remain host-owned (`tui-package` Section 5; config-v1).
`resolve` also forces `terminal_suspend: "none"` and moves `ctrl+z` to
`input_undo` when the host passes `terminalSuspend: false`.

Runtime toggles not in `tui.json` live in KV (see R24).

## Behavior

### Stack and renderer lifecycle

- R1. `run(input)` (an `Effect.fn("Tui.run")`) acquires a `CliRenderer` via
  `Effect.acquireRelease` with: `targetFps: 60`, `exitOnCtrlC: false`, kitty
  keyboard protocol, `useMouse` only when `!Flag.OPENCODE_DISABLE_MOUSE &&
  config.mouse`, `externalOutputMode: "passthrough"`, console copy binding
  `ctrl+y`. Release always calls `destroyRenderer` (`util/renderer.ts`):
  clears the terminal title, then `destroy()` unless already destroyed.
- R2. Before mounting, the app prewarms palette detection
  (`renderer.getPalette({ size: 16 })`, errors swallowed) and waits up to
  1000 ms for the terminal theme mode, defaulting to `"dark"`. This mode is
  the initial `ThemeProvider` mode.
- R3. `registerOpencodeKeymap` (keymap.tsx) is registered with an
  acquire-release unregister; finalizers dispose the plugin host (errors
  logged, never thrown) and the audio system. `SIGHUP` destroys the
  renderer; renderer `"destroy"` resolves the shutdown `Deferred`. On win32
  the app disables processed input at start and flushes the input buffer at
  exit (`terminal-win32.ts`; the Ctrl-C guard itself is host-installed).
- R4. `run` resolves with `{ epilogue, reason }`: `reason` (from
  `ExitProvider.exit(...)`) is printed to stderr through
  `cliErrorMessage`/`errorFormat` and sets `process.exitCode = 1`;
  `epilogue` (from `EpilogueProvider`, e.g. the session-share footer) to
  stdout. The legacy thread host then `process.exit()` (no forced code)
  after stopping the worker, so fatal startup errors exit nonzero —
  `cliErrorMessage` renders a server `ConfigRemoteAuthError` with a
  re-auth hint (`opencode auth login <url>`).
- R5. `Flag.OPENCODE_SHOW_TTFD` mounts `TimeToFirstDraw`;
  `OPENCODE_FAST_BOOT` sets `skipInitialLoading` (hides `StartupLoading` and
  makes `sync.ready` unconditional); `OPENCODE_ROUTE` (JSON
  `{type,sessionID|id}`) overrides the initial route.

### Legacy worker model

- R6. The legacy thread command resolves the target directory (`--project`
  relative to `$PWD`, then `process.chdir`), spawns a `Worker`
  (`OPENCODE_WORKER_PATH` define in compiled builds, else
  `src/cli/tui/worker.ts`) with the filtered environment, and talks to it
  via `Rpc.client<typeof rpc>`.
- R7. Default transport is in-process: `fetch` is bridged over RPC — the
  worker executes requests against `Server.Default().app.fetch`, injecting
  the local server auth header. Events are bridged likewise: the worker's
  `GlobalBus.on("event")` emits `global.event` RPC notifications, surfaced
  to the app as an injected `EventSource`. URL is the sentinel
  `http://opencode.internal`.
- R8. With explicit network flags (`--port`, `--hostname`, mdns) the host
  asks the worker to `server` (stop+listen) and uses real URL + auth headers
  + SDK SSE. `validateSession` runs against the chosen transport before the
  TUI starts; failure aborts with exit code 1.
- R9. Worker lifecycle: `SIGUSR2` on the UI process triggers worker
  `reload` (config invalidate + dispose all instances + emit
  `server.instance.disposed`, which the TUI answers with a full
  `sync.bootstrap()`); a 1 s delayed `checkUpgrade` runs the upgrade check;
  on TUI exit the host calls `shutdown` (5 s timeout) then
  `worker.terminate()`.
- R10. The worker swallows `unhandledRejection`/`uncaughtException` so UI
  teardown races cannot kill it before cleanup; the TUI process owns the
  user-visible failure surface.

### New-CLI daemon launch

- R11. `packages/cli` default handler obtains `{ url, headers }` from
  `Daemon.Service`: a registered healthy server with a matching version is
  reused; otherwise a stale one is stopped (SIGTERM→SIGKILL with same-
  registration guard) and a detached `serve --register` child is spawned.
  Auth is a persisted 0600 password file. The TUI then runs with
  `TuiConfig.resolve({}, { terminalSuspend: false })`, empty args, a no-op
  plugin host, and `gracefulFetch`, which maps legacy-endpoint 404s
  (`/config/providers`, `/provider`, `/agent`, `/config`) to empty defaults
  so the app boots into the provider-connect screen instead of crashing.

### Provider tree and gating

- R12. `createSimpleContext` providers render children only once
  `init.ready === true` (KV, and any async-ready context gate their
  subtrees); missing providers throw on `use` with the context name.
- R13. Mount order in `run` (outer→inner): `ExitProvider` →
  `EpilogueProvider` → `ErrorBoundary` (`ErrorComponent` fallback) →
  `TuiPathsProvider` → `TuiTerminalEnvironmentProvider` (platform, tmux/
  screen, wayland/x11 sniffing) → `TuiStartupProvider` → `ClipboardProvider`
  → `OpencodeKeymapProvider` → `ArgsProvider` → `KVProvider` →
  `ToastProvider` → `RouteProvider` → `TuiConfigProvider` →
  `PluginRuntimeProvider` → `SDKProvider` → `PermissionProvider` →
  `ProjectProvider` → `SyncProvider` → `DataProvider` → `ThemeProvider` →
  `LocalProvider` → `PromptStashProvider` → `DialogProvider` →
  `FrecencyProvider` → `PromptHistoryProvider` → `PromptRefProvider` →
  `EditorContextProvider` → `LocationProvider` → `App`.
- R14. `App` builds the plugin API (`createTuiApi` over host adapters) and
  starts `pluginHost.start(...)` asynchronously; plugin failure logs to
  console but the app still becomes `ready` (the UI renders without plugin
  slots filled). `StartupLoading` covers the pre-ready period unless
  skipped.

### SDK and event pipeline

- R15. `SDKProvider` creates `createOpencodeClient` (v2) with
  url/directory/fetch/headers and one `AbortController`-scoped lifetime. If
  the host injected `events`, subscriptions go through it; otherwise the
  context opens SDK SSE (`sdk.global.event`) with reconnect and exponential
  backoff 1 s → 30 s. When experimental workspaces are enabled,
  `sdk.sync.start()` is issued after subscribing.
- R16. Events are queued and flushed inside `solid.batch`: a flush within
  16 ms of the previous one coalesces with a 16 ms timer, so bursts of
  `message.part.delta` produce a single render. `useEvent` filters out
  `sync` envelope events and tags each handler with
  `{ directory, workspace }` metadata.

### Routes and screens

- R17. `Route` is a Solid store of `{ type: "home", prompt? } | { type:
  "session", sessionID, prompt? } | { type: "plugin", id, data? }`;
  `navigate` applies `reconcile`. `-c` seeds a dummy session route so the
  session list loads in the blocking bootstrap phase; the newest root
  session is then navigated to (forking via `session.fork` if `--fork`).
  `--session <id>` navigates directly (fork waits for full sync to avoid a
  reconcile race). Unknown plugin routes render `PluginRouteMissing` with a
  go-home action.
- R18. Home renders the `home_logo`/`home_prompt`/`home_prompt_right`/
  `home_bottom`/`home_footer` plugin slots around the logo, the shared
  `Prompt`, and toasts; prompt max width is `prompt.max_width`
  (int or `"auto"` = `max(75, 70% terminal width)`, default 75). A
  `--prompt` arg seeds and, once sync+model stores are ready, auto-submits
  exactly once.
- R19. The session screen syncs on every sessionID change: `session.get`
  (not-found → toast + navigate home), workspace switch →
  `project.workspace.set` + non-fatal `sync.bootstrap` + `editor.reconnect`,
  then `sync.session.sync(sessionID)` and snap to bottom. The transcript is
  a sticky-bottom `scrollbox` of messages (`For` + `Switch`): the revert
  marker row at the revert message, user messages (agent-colored left
  border, file badges, QUEUED badge for messages after the pending
  assistant, compaction separator part), and assistant messages whose parts
  dispatch through `PART_MAPPING` (`text` → markdown, `tool` → per-tool
  renderers with a `GenericTool` fallback, `reasoning` → reasoning view,
  `meta` → transcript line — see `tui-session-display`).
- R20. Below the transcript, in order: the active `PermissionPrompt` (first
  pending request across the session and its children), else the active
  `QuestionPrompt`, else (for root sessions) the prompt slot with the shared
  `Prompt`; child (subagent) sessions get `SubagentFooter` instead. The
  prompt is disabled while permissions/questions are pending. The sidebar is
  inline when width > 120, otherwise an absolute-positioned overlay;
  visibility mode is KV-backed (`sidebar: auto|hide` + manual toggle).

### Keymap and commands

- R21. `registerOpencodeKeymap` installs: the default OpenTUI keymap bundle,
  comma-chord bindings, key aliases (`enter`→`return`, `esc`→`escape`,
  `pgup`/`pgdown`), base-layout fallback, escape-clears and
  backspace-pops pending sequences, the timed `leader` token
  (`keybinds.leader`, timeout `leader_timeout`), and a managed textarea
  layer that owns `input.*` editing commands only while a
  `TextareaRenderable` (not `InputRenderable`) has focus.
- R22. The mode stack (`opencode.mode`) defaults to `base`; dialogs push
  `modal`, prompt autocomplete pushes `autocomplete`, the question prompt
  pushes `question` (`tui-plugins` documents plugin use). Layers declaring
  `mode` are gated by `require(OPENCODE_MODE_KEY, value)`. Popping is by
  stack-entry identity (idempotent).
- R23. Components register commands via `useBindings({ commands })` with
  `namespace: "palette"` (palette visibility), optional `title`, `category`,
  `desc`, `suggested`, `hidden`, `enabled()`, `slashName`, `slashAliases`.
  Bindings are gathered per group through the resolved config: app-level
  (`app`, base mode), global (`app.global` — session list/new/quick-switch
  1–9, active even in dialogs), `app_exit` (only when the prompt is unfocused
  or empty), session-level (`session`, base mode), `session.global` and
  `session.global.unfocused` (scroll commands; the latter only when no
  editor is focused).
- R24. Built-in command inventory (app: `src/app.tsx`; session:
  `src/routes/session/index.tsx`; prompt: `src/component/prompt/index.tsx`;
  the rest in feature plugins). Slash names: `/sessions` (aliases `resume`,
  `continue`), `/new` (`clear`), `/workspaces`, `/models` (`mo`),
  `/agents`, `/mcps`, `/variants`, `/connect`, `/org` (`orgs`,
  `switch-org`; only with switchable orgs), `/status`, `/debug`, `/themes`,
  `/help`, `/exit` (`quit`, `q`), `/share`, `/rename`, `/timeline`,
  `/fork`, `/compact` (`summarize`), `/unshare`, `/undo`, `/redo`,
  `/timestamps` (`toggle-timestamps`), `/thinking` (`toggle-thinking`),
  `/copy`, `/export`, `/editor`, `/diff` (diff-viewer plugin). Commands
  without slash names cover visible toggles (sidebar, tool details,
  scrollbar, generic tool output, theme mode/lock, permission auto-approve,
  workspace management) and hidden ones (model/agent/variant cycling,
  quick-switch, scrolling, message jumps, child-session navigation,
  `session.background`, `session.interrupt`, `prompt.*`, terminal/debug
  toggles, plugin manager `plugins.list`/`plugins.install`).
  Slash entries shown in autocomplete come only from palette commands with
  `slashName`; selecting such an entry dispatches the corresponding keymap
  command (autocomplete `onSelect`), while submitting a `/name` first token
  that matches a server command (`sync.data.command`) sends
  `session.command` instead — any other `/…` text is submitted as an
  ordinary prompt.
- R25. `tui.command.execute` events (workspace-gated) dispatch commands
  remotely; `tui.session.select` navigates; `tui.toast.show` raises toasts;
  `tui.prompt.append` inserts text into the focused prompt.

### Legacy sync store

- R26. `bootstrap()` runs a blocking phase — `config.providers`,
  `provider.list`, experimental capabilities, console state, `app.agents`,
  `config.get`, project paths (plus `session.list` when `--continue`) — and
  sets status `loading → partial`; failures are fatal (app exit) in the
  initial bootstrap. A non-blocking phase (session list otherwise, command
  list, lsp/mcp/resource/formatter statuses, session statuses, provider
  auth, vcs, workspace sync) completes the store to `complete`;
  `server.instance.disposed` (after worker reloads) re-runs the same fatal
  bootstrap, while the session-open workspace switch runs it with
  `{ fatal: false }`.
- R27. The store shape: `provider`, `provider_default`, `provider_next`,
  `provider_auth`, `console_state`, `capabilities`, `agent`, `command`,
  `config`, `session` (list windowed to the last 30 days, filtered by
  directory-relative path unless KV `session_directory_filter_enabled` is
  false), `session_status`, `session_diff`, `todo`, `message[sessionID]`,
  `part[messageID]`, `permission[sessionID]`, `question[sessionID]`,
  `lsp`, `mcp`, `mcp_resource`, `formatter`, `vcs`. Events keep sorted
  arrays consistent via binary-search insert (`search`) and `reconcile`
  updates; `message.part.delta` appends the delta string to the named field
  of the found part.
- R28. Client-side retention: a session keeps at most its newest 100
  messages; overflow drops the oldest message and its parts. Hydration
  (`sync.session.sync(sessionID)`) fetches session + last-100 messages +
  todos + diff in parallel, once per session (guarded against concurrent
  runs), and a hydration tracker shields messages/parts already updated by
  live events from being overwritten by the (older) fetch — except a
  fetched empty `text`/`reasoning` body never clobbers non-empty streamed
  text.
- R29. `permission.asked` in auto mode immediately replies `"once"` without
  storing the request; `question.asked`/`permission.asked` are otherwise
  inserted per session; `replied`/`rejected` events remove them.

### V2 data store

- R30. `DataProvider` maintains `session.info/message/permission/question`,
  `project.permission`, and per-location catalogs (`agent`, `command`,
  `integration`, `model`, `provider`, `reference`, `skill`) keyed by
  `[directory, workspaceID]`. It subscribes to the same event stream,
  reshaping `V2Event`s, and projects `session.next.*` events into a local
  transcript (user/assistant/shell/system/compaction messages; assistant
  `content` items `text`/`tool`/`reasoning` with pending/running/completed/
  error tool states). Catalog refreshes trigger on `catalog.updated`,
  `reference.updated`, and `integration.updated`. Today only the prompt
  autocomplete (plus `v2.fs.find`) consumes it; the session screen still
  renders from the legacy store.

### Local state

- R31. Agent selection covers visible non-subagent agents; missing
  selection falls back to the first; `agent.color` resolves hex or theme
  key, else the theme color cycle by visible-agent index. Model selection
  resolves per-agent overrides → agent default → `--model` arg →
  `config.model` → recent list → first provider's default/first model,
  validity-checked against the provider list; selected/recent/favorite/
  variant state persists atomically to `<state>/model.json`. Session pins
  persist to `<state>/session.json` and prune on `session.deleted`;
  quick-switch slots 1–9 navigate to pinned sessions. The current session's
  last user message re-seeds agent/model/variant on session switch (unless
  CLI args pin them).

### Prompt flow

- R32. Submit: sync IME-pending text from the textarea; refuse while
  disabled (pending permission/question), while a workspace/move creation is
  in flight, while autocomplete is open, with empty input, or with no agent.
  Bare `exit`/`quit`/`:q` exit the app. A missing model warns and opens
  provider connect. On the home route a session is created first
  (`session.create` with directory from move detection and selected
  workspace). Pasted content is re-expanded from extmark-tracked parts;
  pending editor selection becomes a leading synthetic `editor_context`
  text part. Dispatch: shell mode → `session.shell`; server `/command` →
  `session.command`; otherwise `session.prompt` with text+file parts
  (throwOnError, toast on failure). The input resets, history appends, and
  the home route navigates to the new session.
- R33. Paste handling: local file paths paste as attachments (text SVG or
  base64 binary); multi-line (≥3 lines) or >150-char pastes collapse to a
  `[Pasted ~N lines]` extmark unless KV `paste_summary_enabled` is false;
  images/PDFs become numbered extmark file parts.
- R34. Interrupt: `session.interrupt` (hidden, enabled while the session is
  busy, prompt focused) requires a second press within 5 s before calling
  `session.abort`; in shell mode the first press only exits shell mode.
- R35. KV-backed display toggles (no `tui.json` keys): terminal title,
  paste summary, animations, file context, diff wrap (`word|none`), session
  directory filter, timestamps, tool details, generic tool output,
  scrollbar, sidebar, thinking mode (`tui-session-display`), auto-permission
  (in-memory from `--auto`/`--yolo`/`--dangerously-skip-permissions`).

### Permission and question UI

- R36. `PermissionPrompt` renders the head request with a three-stage flow
  (`permission` → `always`/`reject`), tool-specific bodies (edit/apply
  patch show a diff viewer with `diff_style` `auto|stacked` and width-based
  split/unified), and replies via `sdk.client.permission.reply`
  (`once`/`always`/`reject`, directory- and workspace-scoped). Inline tool
  rows highlight while their `callID` matches the pending permission and
  classify denial-vs-failure by error-string heuristics.
- R37. `QuestionPrompt` pushes the `question` keymap mode, renders tabs per
  question plus a confirm tab for multi-question sets; single-select
  questions auto-reply on pick; multi-select toggle; custom free-text
  answers (textarea with clear command); replies and rejects go through
  `sdk.client.question.reply`/`reject`.

### Attention, updates, chrome

- R38. `createTuiAttention` (attention.ts) owns focus tracking,
  terminal-mediated notifications (ANSI-stripped, 240-char message/80-char
  title caps), and the semantic soundboard (`default`, `question`,
  `permission`, `error`, `done`, `subagent_done`) with the built-in
  `opencode.default` pack, per-call `when: always|focused|blurred` gates,
  and config slot overrides — the `attention` config block and `api.attention`
  plugin surface are specified by `tui-plugins`.
- R39. `installation.update-available` shows a confirm dialog (KV
  `skipped_version` suppression; "don't ask again"), then
  `global.upgrade` with progress/success toasts and an exit prompt.
- R40. The terminal title mirrors the route: `OpenCode` on home and
  default-titled sessions, `OC | <title>` (clamped to 40 chars) otherwise,
  `OC | <plugin id>` for plugin routes; toggle via KV and
  `Flag.OPENCODE_DISABLE_TERMINAL_TITLE`. Selection: mouse-up copies the
  selection (or right-click copy when copy-on-select is experimentally
  disabled); `renderer.console.onCopySelection` writes to the clipboard.

### RTL

- R41. No explicit RTL/directional support exists in `packages/tui`: layout
  is fixed LTR (sidebar right, left borders, paddingLeft indentation); any
  bidi shaping is delegated to `@opentui/core` text measurement. The
  desktop/web RTL work lives outside this package
  (`packages/session-ui`, `packages/app`).

## Module map

| File (under `packages/tui/src`) | Responsibility | Contract |
|---|---|---|
| `index.tsx` | Package root | Exports `run`, `TuiInput` only |
| `app.tsx` | Renderer lifecycle, provider composition, app-level commands/events, route switch, plugin host start | R1–R14, R17–R25 |
| `keymap.tsx` | OpenTUI keymap bootstrap, mode stack, leader/aliases, slash entry derivation | R21–R24 (`tui-plugins` for plugin layers) |
| `config/index.tsx`, `config/keybind.ts` | TUI config schema, `resolve`, binding lookup, provider | R24 groups; config-v1 |
| `context/helper.tsx` | `createSimpleContext` factory | ready-gating + named errors (R12) |
| `context/sdk.tsx` | SDK client + event emitter with batching/backoff | R15–R16 |
| `context/event.ts` | Typed event subscription with metadata | R16 |
| `context/sync.tsx` | Legacy sync store, bootstrap, hydration, retention | R26–R29 |
| `context/data.tsx` | V2 store and event projection | R30 |
| `context/local.tsx` | Agent/model/session-pin local state + persistence | R31 |
| `context/kv.tsx` | KV store with flock + serialized writes | R24/R35 |
| `context/permission.tsx` | auto/normal permission mode | R29/R36 |
| `context/project.tsx` | Instance paths, project id, workspaces | R19/R26 |
| `context/theme.tsx` | Theme selection, mode detect/lock, custom-theme discovery, system theme | `tui-theme` |
| `context/editor.ts`, `editor.ts`, `editor-zed.ts` | Editor selection integration (websocket/Zed), external editor launch | R32 |
| `context/route.tsx` | Route store | R17 |
| `context/runtime.tsx` | Frozen paths/terminal-environment/startup providers | R5 |
| `context/args.tsx` | CLI args | `TuiInput.args` |
| `context/location.tsx` | Current session `LocationRef` | R19 |
| `context/thinking.ts` | Thinking mode KV + migration | `tui-session-display` |
| `context/clipboard.tsx`, `clipboard.ts` | Clipboard abstraction | R40 |
| `context/exit.tsx`, `epilogue.tsx` | Exit reason / stdout epilogue | R4 |
| `context/directory.ts`, `path-format.tsx` | Directory/branch and path display | — |
| `routes/home.tsx`, `routes/home/session-destination.tsx` | Home screen + new-session destination | R18 |
| `routes/session/index.tsx` | Session screen, commands, part renderers | R19–R20, R24 |
| `routes/session/permission.tsx`, `question.tsx` | Permission/question prompts | R36–R37 |
| `routes/session/sidebar.tsx`, `subagent-footer.tsx`, `dialog-*.tsx` | Sidebar, subagent footer, session dialogs | R20 |
| `component/prompt/index.tsx` | Shared prompt component, submit/paste/interrupt | R32–R35 |
| `component/prompt/autocomplete.tsx` | `@`/`/` autocomplete (files, agents, commands; V2 fs/skills) | R24, R30 |
| `component/prompt/{history,frecency,stash,workspace,move,local-attachment}.ts(x)` | Prompt persistence and destination helpers | R32 |
| `component/dialog-*.tsx`, `command-palette.tsx` | Built-in dialogs and palette | R23–R24 |
| `ui/dialog.tsx`, `ui/dialog-*.tsx`, `ui/toast.tsx` | Dialog stack, primitives, toasts | R22, R37 |
| `plugin/runtime.tsx`, `plugin/slots.tsx`, `plugin/api.ts`, `plugin/adapters.tsx` | Plugin runtime state, slot rendering, API construction | `tui-plugins` |
| `feature-plugins/**` + `feature-plugins/builtins.ts` | Built-in feature plugins (home footer/tips, sidebar panels, notifications, plugin manager, which-key, diff viewer) | `tui-plugins` |
| `attention.ts`, `audio.ts` | Attention/sound system | R38 |
| `parsers-config.ts` | Remote tree-sitter wasm + query registry (markdown/js/ts use OpenTUI built-ins) | R19 |
| `theme/**` | Theme JSON engine | `tui-theme` |
| `util/*` | Presentation/persistence utilities (renderer destroy, error format, persistence, transcript, …) | R1, R4, R32 |
| `terminal-win32.ts` | Win32 input handling | R3 |
| `logo.ts` | ASCII logo | — |

Relationship to `packages/session-ui`: none at runtime. `session-ui`
(`@opencode-ai/session-ui`) is the browser/desktop Solid component library
for session rendering (shiki, CSS, kobalte, storybook); neither package
imports the other, and both consume `@opencode-ai/sdk` wire types
independently. The TUI renders markdown/diffs with OpenTUI renderables
instead of `session-ui` components; behavior parity between the two front
ends is not guaranteed by either package.

## Stubs and known limitations

- `routes/session/footer.tsx` (`Footer`) is not imported anywhere: the home
  footer is provided by the `internal:home-footer` feature plugin through the
  `home_footer` slot, and session status lives in the prompt/sidebar. The
  file is dead code retained from the pre-plugin layout.
- The V2 `Data` store is wired into the app tree but consumed only by the
  prompt autocomplete (`useData`, `v2.fs.find`); the session screen still
  renders exclusively from the legacy `Sync` store. Migration of the session
  screen to the V2 projection is unfinished.
- `./plugin/command-shim` is still exported and instantiated by the legacy
  plugin host; its removal is specified by `opencode-v2-tui-shim`.
- `packages/cli` boots the TUI against legacy endpoints through
  `gracefulFetch` 404 shims (empty providers/agents/config), degrading to
  the provider-connect screen until the daemon serves the v2 surface.
- Tree-sitter wasm parsers and highlight queries are fetched from remote
  release URLs at render time (`parsers-config.ts`); markdown, JavaScript,
  and TypeScript use the OpenTUI built-ins, everything else needs network
  access on first use.
- Narrow `@opencode-ai/core` utility imports (`Global`, `Flag`, `Flock`,
  `Glob`, `InstallationVersion`, `@opencode-ai/ui` audio assets) remain
  inside the package, a conscious deviation from the stricter dependency
  aspiration recorded in `tui-package`.

## Constraints

- The package must not import `packages/opencode`, `packages/cli`, or
  backend domain implementations; OpenCode data and operations come only
  from `@opencode-ai/sdk` (`tui-package`). Narrow `@opencode-ai/core`
  utility imports (`Global`, `Flag`, `Flock`, `Glob`, `InstallationVersion`)
  currently exist and are the accepted remnant of the extraction.
- Renderer cleanup must restore the terminal on every exit path: normal
  exit, interruption, startup failure, renderer destroy, SIGHUP (R1, R3).
- One canonical TUI implementation: hosts may not fork or embed a second
  app tree (`tui-package`).
- Event application must stay inside `batch` so a burst of deltas equals one
  render (R16); a violation is a perf regression, not a correctness bug.
- The client-side 100-message retention and hydration shielding (R28) must
  not be bypassed by direct store writes outside `sync.tsx`.
- KV writes are flock-serialized and atomic; concurrent TUI processes must
  not lose updates (R24/R35).
- Unknown tools and malformed tool metadata must render through the
  `GenericTool` fallback without crashing the session view (root
  `ErrorBoundary` is the last resort, not the mechanism) (`tui-package`
  Section 3).
- Remote-server use must remain possible: no code path may require an
  in-process backend (attach/new-CLI transports prove this).

## Error handling

- Blocking bootstrap failure exits the app with the error as exit reason
  (stderr rendering per R4); non-blocking refresh failures leave the
  previous store value.
- Session open failure (not found / fetch error) toasts and navigates home
  (R19).
- `session.prompt` failure surfaces as an error toast; `session.create`
  failure toasts and keeps the input.
- Plugin host start failure logs and continues with a plugin-less UI (R14);
  plugin dispose failures are logged during shutdown.
- SSE disconnections retry with backoff; during the gap the store simply
  stops updating (no stale-clear).
- Worker shutdown is best-effort (5 s timeout) before terminate (R9).

## Dependencies

- `tui-package` — ownership boundary, migration invariants, host/package
  split.
- `tui-theme` — theme resolution and key mapping (referenced, not restated).
- `tui-session-display` — thinking mode, reasoning timer, meta parts.
- `tui-plugins` — plugin config/loading/slots/API and the `modal` mode.
- `opencode-v2-tui-shim` — planned removal of the legacy `api.command`
  shim still exported via `./plugin/command-shim`.
- `config-v1` — `tui.json` keys and `keybinds.<command>` rebinding.

## Used by

- `packages/opencode` (thread/attach commands, worker, plugin host),
  `packages/cli` (default command, daemon transport), `packages/plugin`
  (TUI plugin type contract).

## Verification

No formal verification (TLC/TLAPS) applies. Package checks: `bun typecheck`
and `bun test` from `packages/tui` (smoke render `test/index.test.tsx`,
lifecycle `test/app-lifecycle.test.tsx`, keymap, config, plugin runtime and
slots, reasoning-display tests); host typechecks from `packages/opencode`
and `packages/cli`. Interactive smoke in tmux per `tui-package` verification
gates.
