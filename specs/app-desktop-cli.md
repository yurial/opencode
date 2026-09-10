# App, Desktop, UI, and CLI Entry Points

Status: draft (as-built behavior specification — describes what the current
code does; stubs and unfinished migrations are called out inline and at the
end).

Reference: `app-desktop-cli`

Related documents (not duplicated here):

- `specs/tui-architecture.md` (reference `tui-architecture`) — the terminal
  client. Its "Hosts" table already covers how `packages/cli` launches the
  TUI; this spec adds the rest of the CLI surface.
- `specs/server-api-sdk.md` (reference `server-api-sdk`) — the V2 Protocol/
  Server/Client/SDK stack that the app and CLI consume; the `serve` handler
  and Daemon transport mechanics on the server side are specified there.
- `specs/tui-theme.md` (reference `tui-theme`) — terminal theming; desktop/web
  theming is a different system (`packages/ui/src/theme`, this spec).
- `AGENTS.md` — style and dependency rules.

## Scope

In:

- `packages/app/` — the shared SolidJS web/desktop application
  (`@opencode-ai/app`): entrypoints, routing, provider tree, server
  connection model (legacy SDK + vendored V2 client + v1/v2 compatibility),
  client state and persistence, the platform abstraction, desktop menu
  model, updater contract, and the WSL server UI.
- `packages/desktop/` — the Electron wrapper (`@opencode-ai/desktop`): main
  process, sidecar server management (v1 utility process and v2 background
  CLI), windows, IPC surface, renderer bootstrap, WSL subsystem, updater,
  and packaging.
- `packages/ui/` — the shared UI primitive library (`@opencode-ai/ui`):
  exports contract, theme system, i18n layer, dialog/markdown/file contexts,
  v2 component set.
- `packages/cli/` — the new CLI (`@opencode-ai/cli`, binary `lildax`):
  command inventory, Daemon service, serve mode, TUI launch, build/publish
  pipeline, and differences from the legacy CLI in `packages/opencode/src/cli`.
- `packages/web/` — briefly: purpose and boundaries only.
- One-to-three-line summaries: `packages/storybook`, `packages/console`,
  `packages/enterprise`, `packages/identity`, `packages/slack`,
  `packages/containers`, `packages/function`, `packages/codemode`,
  `packages/http-recorder`, `packages/httpapi-codegen`, `packages/stats`.

Out (non-goals):

- Session/timeline rendering internals of `packages/app`
  (`src/pages/session/**`) and `packages/session-ui` component behavior; only
  their boundaries are recorded.
- The V2 HTTP surface itself (endpoints, middleware, transports) — owned by
  `server-api-sdk`.
- The legacy `opencode` CLI command behavior (`packages/opencode/src/cli`)
  beyond the comparison table in [packages/cli](#packages-cli-opencode-ai-cli).
- TUI internals (`tui-architecture`).
- Cloud deployment topology (SST resources) of console/enterprise/function/
  stats beyond their stated purpose.

## Topology

```text
packages/ui ──────── consumed by ─▶ app, desktop, enterprise, session-ui, storybook, tui (assets)
packages/app ────── consumed by ─▶ desktop (renderer), web-adjacent deploys (app.opencode.ai)
packages/cli ────── deps: core, sdk, server, tui (workspace); publishes @opencode-ai/cli-* binaries
packages/desktop ── deps: app, ui (workspace); bundles legacy server (packages/opencode dist)
                    and a published @opencode-ai/cli binary for its two sidecar modes
```

The app talks to servers only over HTTP (legacy SDK `@opencode-ai/sdk/v2` for
v1 endpoints, the vendored Promise client `@opencode-ai/client` for `/api/*`).
It never embeds server code — the opposite of sdk-next (`server-api-sdk`).

## packages/app (`@opencode-ai/app`)

### Purpose and exports

The web/desktop application: project/session UI, timeline, prompt composer,
terminals (PTY), settings, provider connection, permissions, notifications.
It is a Vite + SolidJS app with two hosts: the browser (`src/entry.tsx`) and
the Electron renderer (`packages/desktop/src/renderer/index.tsx`). Hosts mount
`AppInterface` and provide a `Platform`.

`package.json` exports (the host contract):

| Export | Content |
|---|---|
| `.` | `AppBaseProviders`, `AppInterface`, context hooks (`useServer`, `useServerSDK`, `useServerSync`, `useSettings`, `useTabs`, `useLayout`, `useCommand`, `useProviders`, `useLanguage`, `useWslServers`), `ServerConnection`, `Platform`, draft store, file-picker constants |
| `./desktop-menu` | `DESKTOP_MENU` declarative menu model (see A21) |
| `./i18n/desktop-native` | Typed keys for native (main-process) translations |
| `./updater` | `UpdaterState`/`UpdaterPlatform` contract |
| `./wsl/types` | WSL server state model (see A23) |
| `./vite` | Vite plugin reused by desktop renderer builds (alias `@`, `OPENCODE_CHANNEL` define, theme preload inlining, tailwind+solid) |
| `./index.css` | Global styles |

Runtime deps of note: `@opencode-ai/sdk` (workspace, legacy client),
`@opencode-ai/client` — **vendored tarball**
`vendor/opencode-ai-client-1.17.13-v2.tgz`, a published snapshot of the
private `packages/client` (see Divergences), `@opencode-ai/core` /
`@opencode-ai/schema` (utilities), `@opencode-ai/session-ui`,
`@opencode-ai/ui`, `ghostty-web` (terminal canvas), `@tanstack/solid-query`.

### Web entry

**File:** `src/entry.tsx`.

- A1. Builds a `Platform` with `platform: "web"`: browser notifications
  (skipped when visible/focused), `openExternal` restricted to
  `http:`/`https:`/`mailto:`, `restart` = `location.reload`, localStorage
  draft store, default-server URL persisted under
  `opencode.settings.dat:defaultServerUrl`.
- A2. Server URL resolution: a hostname containing `opencode.ai` defaults to
  `http://localhost:4096` (local-dev carve-out); `import.meta.env.DEV` uses
  `VITE_OPENCODE_SERVER_HOST/PORT` (default `localhost:4096`); production
  uses `location.origin`. An `auth_token` query parameter (base64
  `user:pass`) is decoded into basic credentials and stripped from the URL.
- A3. Renders `PlatformProvider → AppBaseProviders → AppInterface` with the
  single resolved HTTP server and `disableHealthCheck` (the web entry skips
  the blocking startup health gate).
- A4. Sentry is initialized when `VITE_SENTRY_DSN` is set; the Breadcrumbs
  integration is dropped and GlobalHandlers additionally dropped on the
  `prod` channel.

### AppInterface and provider tree

**File:** `src/app.tsx`.

- A5. `AppInterface` props are the embedding contract:
  `defaultServer`, `canonicalLocalServer`, `servers` (extra connections),
  `router` (component override — desktop passes a MemoryRouter), optional
  `disableHealthCheck`, `startup` (a promise gating first render — desktop
  onboarding), `serverScoped` (chrome injected into server-scoped layout),
  `children`.
- A6. `AppBaseProviders` (outermost, host-owned): `MetaProvider`, `Font`,
  `ThemeProvider` (with `onThemeApplied` → `window.api.setTitlebar` when the
  desktop bridge exists), `LanguageProvider`, a bridge into the UI package's
  `I18nProvider`, a root `ErrorBoundary` (Sentry + `ErrorPage`), a
  `QueryClient` (no refetch on mount/focus/reconnect), `WslServersProvider`,
  `DialogProvider`, `FileComponentProvider` (rendering files with
  session-ui's `File`).
- A7. Below `ServerProvider → GlobalProvider → SettingsProvider`, the
  `ConnectionGate` runs a startup health check: blocking first (10 s
  timeout), then background mode retries every second and offers switching
  to another known server while showing `ConnectionError`; non-HTTP
  connection types keep retrying instead of failing fast. A `Splash` overlay
  covers loading (health check + `startup` promise).
- A8. Router root: `TabsProvider → PermissionProvider → NotificationProvider`
  around a shared shell (`QueryProvider`, `CommandProvider` + desktop-only
  commands such as `logs.export`, `HighlightsProvider`) and the layout:
  `NewAppLayout` when the `newLayoutDesigns` setting is on (default `true`
  for new installs; upgrade cutoff `1.17.19` decides migrating installs —
  `src/context/settings.tsx`), else the legacy `LegacyLayout`.
- A9. Routes (`Routes` in `app.tsx`):
  - legacy layout: `/` (`LegacyHome`), `/server/:serverKey/session/:id`
    (redirect via session lineage), and under `/:dir` (base64 directory):
    `/session/:id?`;
  - new layout: `/` (`NewHome`), `/server/:serverKey/session/:id`
    (`TargetSessionRoute`), `/:dir/session/:id` (redirects into the tab
    route), `/new-session?draftId=…` (`DraftRoute`, new-session composer);
  - a session route without `id` under the new layout creates a draft tab
    instead.
- A10. Server-identity remounting: `TargetServerRoute` keys its subtree on
  the validated `serverKey` (`Show … keyed`), wrapping
  `ServerSDKProvider + ServerSyncProvider`. Session changes inside must not
  remount it — `SessionRouteErrorBoundary` resets and `createSessionLineage`
  re-resolve reactively; both rely on that key. `LayoutCompatibility` keeps
  the legacy layout off v2-only servers by auto-switching to a v1 server
  when one exists.

### Server model

**Files:** `src/context/server.tsx`, `src/utils/server-scope.ts`.

- A11. `ServerConnection.Any` = `Http` (`{type:"http", http:{url, username?,
  password?}, authToken?}`) | `Sidecar` (`variant: "base"` desktop server or
  `variant: "wsl", distro`) | `Ssh` (`{host, http}` proxy) — sidecar/ssh are
  desktop-only. `ServerConnection.key`: URL for http, `"sidecar"`,
  `wsl:<distro>`, `ssh:<host>`. `Ssh` currently has no runtime producer
  (tests only).
- A12. `ServerProvider` persists `server.v3` (via the scoped persistence
  layer, A19): the stored server list (merged, deduped by key, with
  host-injected `servers` props winning), per-scope project lists
  (`projects`, `lastProject`, `recentlyClosed` — history cap 16, display
  cap 5), and the active key (falls back to `defaultServer`). Removal picks
  the fallback server then the first remaining. A canonical-local-server
  migration folds a legacy per-server project scope into `"local"`.
- A13. `ServerScope` maps a server key to a persistence scope (`sidecar` and
  the canonical local URL collapse to `"local"`); session-state keys compose
  scope + route. `GlobalProvider` (`src/context/global.tsx`) keeps one
  `createRoot` server context per known connection (`ensureServerCtx`),
  disposes contexts for removed servers, and polls server health
  (`useServerHealth`, 10 s interval).

### SDK stack and protocol compatibility

**Files:** `src/context/server-sdk.tsx`, `src/utils/server.ts`,
`src/utils/server-protocol.ts`, `src/utils/server-compat.ts`.

- A14 (protocol detection). `detectServerProtocol` probes
  `/global/health` (JSON `{healthy:true}` → `v1`), then `/api/health`
  (`pid:number` → `v2`, `{healthy:true}` → `v1`), defaulting to `v2`;
  5 s timeout per probe, basic-auth headers included.
- A15 (clients). Per server: a legacy `createOpencodeClient`
  (`@opencode-ai/sdk/v2`) with `throwOnError`, and the vendored V2 Promise
  client `OpenCode.make` (`ServerApi`). Basic auth is always derived from
  the connection's password. `createCompatibleApi` returns a Proxy
  (`lazyApi`) that resolves each namespace/method against the v1 or v2
  implementation once the protocol promise settles — v1 adapters
  (`server-compat.ts`) reimplement the v2 surface (`session.*` incl.
  prompt/command/shell/compact/revert, `project.*`, `vcs.*`, `file.*`,
  `integration.*` incl. OAuth flows, `pty.*`, `permission.reply`,
  `question.*`) over legacy endpoints, synthesizing envelope shapes.
- A16 (events). The event stream uses the legacy `global.event` SSE for v1
  and `event.subscribe` for v2; V2 `permission.v2.*`/`question.v2.*` events
  are adapted (`adaptServerEvent`) into the legacy event names the app
  state consumes. Events are queued and flushed at most every 16 ms inside
  `solid.batch`, with coalescing: consecutive `message.part.delta`s and
  V2 `session.*.delta` events merge by key (message/part/field or
  session/message/ordinal/callID), `lsp.updated` and
  `message.part.updated` replace-in-place. The stream yields to the event
  loop every 8 ms, reconnects after 250 ms, logs one failure per outage,
  stops on `pagehide`, and resumes on bfcache `pageshow`
  (`resumeStreamAfterPageShow`).
- A17 (fetch routing). The event stream prefers `platform.fetch` only for
  non-loopback plain-`http:` URLs (the desktop proxy seam); request clients
  use `platform.fetch` when provided. On desktop `platform.fetch`
  currently just delegates to the ambient renderer `fetch`, so the seam is
  present but not yet a proxy. Per-directory SDK contexts are refcounted
  (`ensureDirSdkContext`); `SDKProvider` (`src/context/sdk.tsx`) resolves
  the directory-scoped client reactively for the current server.

### Client state and persistence

**Files:** `src/context/server-sync.tsx`, `src/context/global-sync/*`,
`src/context/{tabs,settings,sync,directory-sync,terminal,permission,notification,…}.tsx`,
`src/utils/persist.ts`.

- A18. `ServerSyncProvider` bootstraps per-server global state (path,
  projects, config, providers, agents, commands, references) and directory
  state via tanstack-query options (`global-sync/bootstrap.ts`), applies
  live events through `global-sync/event-reducer.ts`, maintains root
  session lists (`session-load.ts`, with a v1 fallback loader),
  trims/evicts client-side session caches (`session-trim.ts`,
  `eviction.ts`), and keeps an on-disk home session index
  (`home-session-index.ts`). V2 event projection into the legacy app model
  lives in `server-session-v2-reducer.ts` (see `V1_API_MIGRATION.md`).
- A19. Persistence (`utils/persist.ts`): scoped, versioned stores over
  `@solid-primitives/storage`. Storage names: `default.dat` (legacy),
  `opencode.global.dat` (global), `opencode.window.<windowID>.dat`
  (window-scoped, mirroring desktop's per-window file
  `windowDataFile`); keys are prefixed `opencode.` and composed with the
  server/directory scope; migrations and legacy key fallbacks are declared
  per store; an in-memory cache (≤500 entries / ≤8 MiB, LRU-pruned) fronts
  the async storage. Known stores: `server.v3`, `settings.v3`, tabs.
- A20. Tabs (`context/tabs.tsx`): `SessionTab | DraftTab` per window; drafts
  route to `/new-session?draftId=…`; session tabs route to
  `/server/:serverKey/session/:id`; tab identity keys are stable strings;
  closed tabs are remembered (`closed-tabs.ts`) with migration support
  (`tab-migration.ts`).

### Platform, menu, updater, WSL

- A21 (`src/desktop-menu.ts`). The native menu is data: `DESKTOP_MENU`
  describes app/file/edit/view/go/window/help with i18n label keys,
  in-app `command:` ids (dispatched through the app command registry,
  e.g. `settings.open`, `session.new`, `sidebar.toggle`), `action:` ids
  (Electron-native behaviors, e.g. `view.reload`, `window.new`), Electron
  `role`s, per-platform accelerators, and `enabled: "updater"` gating. The
  Electron main process renders it (`desktop/src/main/menu.ts`); the
  renderer renders a Windows in-app variant (`components/windows-app-menu.tsx`).
- A22 (`src/context/platform.tsx`). `Platform` is the capability boundary:
  base web surface (version, openExternal, restart, notify, storage,
  draftStore, windowID, updater?, fetch?, default-server get/set,
  wslServers?) plus desktop-only optionals (pickers, openPath/reveal,
  clipboard image, debug logs, display backend, zoom/fullscreen accessors,
  menu actions, fatal-error reporting). `DisplayBackend` is
  `"auto" | "wayland"` (Linux).
- A23 (`src/wsl/`). WSL management UI for Windows desktops: probe/install
  flows (WSL runtime, distros, opencode-in-distro), server add/remove/start
  (`WslServersPlatform` implemented by desktop IPC), settings model and
  dialogs. On web the provider is inert.
- A24 (`src/updater.ts`). `UpdaterState` machine
  (`disabled/idle/checking/downloading/ready/up-to-date/installing/error`)
  and the `UpdaterPlatform` contract (`state`, `check`, `install`) that the
  desktop bridges over IPC.

### Module map (selected)

| File (under `packages/app/src`) | Responsibility |
|---|---|
| `entry.tsx` | Web host: platform, URL/auth resolution, render |
| `app.tsx` | `AppBaseProviders`/`AppInterface`, routes, server-keyed subtrees, connection gate |
| `context/server.tsx` | Connection model, persistence, project lists |
| `context/server-sdk.tsx` | Per-server clients, protocol switch, event pipeline |
| `context/server-sync.tsx` + `global-sync/` | Bootstrap/query/event-reducer state layer |
| `context/tabs.tsx`, `settings.tsx`, `local.tsx`, `models.tsx`, `permission.tsx`, `terminal.tsx`, `notification.tsx` | App-level state (window tabs, settings, locals, models, permissions, PTY terminals, notifications) |
| `context/platform.tsx`, `desktop-menu.ts`, `updater.ts` | Host contracts |
| `pages/{home,new-session,session,layout,layout-new,directory-layout,error}` | Screens (new/legacy layout pair, session workspace, drafts) |
| `components/*` | Dialogs, pickers, titlebar/tab strip, terminal, prompt composer, settings, command palette |
| `wsl/*` | WSL server management UI |
| `utils/{server,server-protocol,server-compat,persist,server-scope}.ts` | Client construction, detection, v1 adapters, persistence scoping |

### Testing

`bun test` unit (solid condition, happy-dom preload), `test:browser`
(browser condition), Playwright e2e (`e2e/`, mock server + SSE transport
utilities), and performance suites (`e2e/performance`). Backend expected at
`localhost:4096` by default (`AGENTS.md` local-dev flow).

## packages/desktop (`@opencode-ai/desktop`)

### Purpose

Electron application wrapping the `@opencode-ai/app` renderer, owning:
native windows/chrome, a locally spawned opencode server ("sidecar"),
WSL sidecars (Windows), native menus/dialogs/pickers, storage and drafts,
auto-update, deep links, logging/crash reporting, and packaging.

### Main process lifecycle

**File:** `src/main/index.ts`.

- D1. Channel (`OPENCODE_CHANNEL`) selects identity: `dev`/`beta`/`prod` →
  app name (`OpenCode Dev`/`Beta`/`OpenCode`), app id
  (`ai.opencode.desktop[.dev|.beta]`), userData path
  `<appData>/<appId>`. Not packaged ⇒ dev identity. `OPENCODE_TEST_ONBOARDING=1`
  isolates all paths into a temp root.
- D2. Single-instance lock; a second instance forwards `opencode://` deep
  links and focuses the last window. macOS `open-url` and cold-start links
  buffer into `pendingDeepLinks` until the renderer consumes them.
- D3. Environment prep: `chdir(homedir)` (macOS `/` breakage), loopback
  entries forced into `NO_PROXY`, system CA certificates merged into the
  Node defaults, env proxy applied, `proxy-bypass-list <-loopback>`,
  `OPENCODE_DISABLE_EMBEDDED_WEB_UI=true`; unpackaged runs enable remote
  debugging on 9222. Sidecar env additionally drops `DEBUG` and (Linux)
  `LD_PRELOAD`.
- D4. Lifecycle: `before-quit`/`will-quit`/SIGINT/SIGTERM stop all sidecars
  (then quit); `window-all-closed` quits except on darwin; `activate`
  restores windows; relaunch = stop sidecars → `app.relaunch` + quit;
  `child-process-gone`/`render-process-gone` are logged.
- D5. Startup order: logging + crash reporter → WSL controller → migrate +
  scoped store cleanup → `opencode://` protocol registration + `oc://`
  renderer protocol + dock icon → auto-updater (check every 10 min) → IPC
  registration (incl. WSL) → netlog → sidecar spawn → window restore →
  native menu (macOS only).

### Sidecar servers (two modes)

`SIDECAR_VERSION = process.env.OPENCODE_SIDECAR_V2 === "1" ? "v2" : "v1"`
— **v1 is the default**.

- D6 (v1, `src/main/server.ts` + `src/main/sidecar.ts` + build wiring in
  `electron.vite.config.ts`). The main process picks a free TCP port on
  127.0.0.1 (or `OPENCODE_PORT`), generates a `randomUUID()` password, and
  forks `out/main/sidecar.js` as an Electron `utilityProcess`
  ("opencode server"). The sidecar module imports
  `virtual:opencode-server` — the bundled legacy server build
  (`packages/opencode/dist/node/node.js`, produced by
  `script/build-node.ts`; wasm chunks copied next to the bundle) — and calls
  `Server.listen({port, hostname, username:"opencode", password,
  cors:["oc://renderer"]})`. Start/stop ride a `postMessage` protocol
  (`{type:"start",…}`/`{type:"stop"}` ↔ `ready/stopped/error`) with a 60 s
  stall timeout and a 6 s stop timeout before kill. Readiness resolves a
  `Deferred` served to the renderer over the `await-initialization` IPC.
  Health is polled against `/api/health` and `/global/health` with basic
  auth (30 s budget, non-fatal on timeout). The password travels only in
  the `start` postMessage and is applied inside the utility process as
  `OPENCODE_SERVER_PASSWORD`.
- D7 (v2, `src/main/background-cli.ts`). `startBackgroundCli` resolves the
  bundled `opencode-cli` executable (`resources/` in dev, `process.resourcesPath`
  when packaged; on Windows `opencode-cli.exe`), stages it versioned into
  `<userData>/cli/<version>/` (atomic temp+rename, 0755), then discovers a
  running background service by probing candidate state homes
  (`XDG_STATE_HOME`, shell env state home, the desktop appData names) with
  `service status` (output `running <url>`), and finally runs
  `service start` + `service get password`. Returns
  `{url, username: "opencode", password}`. The dev-channel binary is
  downloaded by `scripts/utils.ts` (`downloadCliToResources`) from the
  published `@opencode-ai/cli-<platform>-<arch>` npm packages pinned at
  `0.0.0-next-16350` (binary name `opencode2` inside the package, staged as
  `opencode-cli`). Those subcommands are the `service` command family of
  `packages/cli` (C-rules below).
- D8. On Windows both modes also initialize the WSL controller
  asynchronously.

### Windows and renderer hosting

**File:** `src/main/windows.ts`.

- D9. Windows: `BrowserWindow` with `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`; macOS hidden titlebar with
  repositioned traffic lights; Windows frameless with a title-bar overlay
  themed from the app theme (`setTitlebar`, height scales with zoom);
  per-window `electron-window-state` files; a persisted window-id registry
  restores the session's windows on launch (ids pruned on deliberate close,
  kept when quitting/updating — `session-end` flags quitting on Windows
  shutdown).
- D10. Renderer content is served over the custom privileged `oc://renderer`
  scheme (secure/standard/fetch/stream) with path containment checks, range
  request support, and a `Document-Policy:
  include-js-call-stacks-in-crash-reports` header on HTML; dev loads
  `ELECTRON_RENDERER_URL`.
- D11. Hardening: window-open handler denies everything (external URLs go
  to the OS after validation); `will-navigate` confines to renderer URLs;
  session permissions are allow-listed to
  `clipboard-sanitized-write` + `notifications` for renderer URLs only;
  CORS headers (`Access-Control-Allow-Origin: *`) are injected for renderer
  traffic.
- D12. Resilience: an unresponsive sampler plus recovery dialogs
  (relaunch / export logs / keep waiting / quit) on `unresponsive`,
  `did-fail-load`, `render-process-gone`; preload errors, PTY-related
  console messages, and renderer fatal errors are logged (and exported via
  debug logs).
- D13. Zoom is clamped 0.2–10 with pinch/Ctrl-scroll gated by a persisted
  `PINCH_ZOOM_ENABLED_KEY`; fullscreen and zoom changes are pushed to the
  renderer; the renderer can push the theme background color
  (`--background-base`) so native chrome matches before first paint.

### IPC surface

**Files:** `src/preload/index.ts` (the complete renderer API, exposed via
`contextBridge` as `window.api`), `src/main/ipc.ts` (handlers),
`src/preload/types.ts`.

- D14. Groups: initialization (`awaitInitialization`, `killSidecar`,
  `consumeInitialDeepLinks`), default server URL get/set, onboarding flags,
  old-layout eligibility, display backend get/set (currently null/undefined
  stubs), app-exists resolution, updater subscribe/check/install
  (state pushed as `updater-state`), scoped key-value stores
  (`store-get/set/delete/clear/keys/length` on named `.dat` stores), drafts
  (`draft-get/set/delete`, blob put/get), window identity/focus/show,
  zoom, pinch-zoom, fullscreen events, titlebar theming, menu-command
  events, desktop menu actions, background color, debug-log export,
  force-focus, fatal renderer errors, native translations bundle, native
  pickers (directory/file with token-scoped sequential file reads and
  release), save dialog, clipboard image, open/reveal path, and the WSL
  API (`wsl-servers-*`).
- D15. Rule (from `packages/desktop/AGENTS.md`): the renderer only calls
  `window.api` from `src/preload`; main-process IPC handlers are registered
  in `src/main/ipc.ts`.

### Renderer bootstrap

**File:** `src/renderer/index.tsx`.

- D16. Builds the desktop `Platform` (OS from UA; IPC-backed storage and
  draft store; attachment picker with native file reads; updater binding;
  restart = kill sidecar + relaunch; notify skips focused windows; zoom /
  fullscreen accessors; `runDesktopMenuAction` handling the zoom trio
  locally and forwarding the rest) and mounts
  `PlatformProvider → AppBaseProviders → AppInterface` with:
  a `MemoryRouter` persisting the per-window last-active URL to
  localStorage; `servers` = sidecar (`awaitInitialization` resource) +
  ready WSL connections; `defaultServer` from the stored default URL or
  the available startup server; `startup` = first-launch onboarding
  promise; `serverScoped` = onboarding UI. Menu commands are bridged into
  the app command registry; theme background syncs to the main process.
- D17. Native translations flow renderer → main
  (`setNativeTranslations`), rebuilding the macOS menu so native labels
  follow the app locale (typed bundle from `@opencode-ai/app/i18n/desktop-native`).

### WSL subsystem

**Files:** `src/main/wsl/*`.

- D18. `createWslServersController` owns WSL server state (runtime probe,
  distro inventory, install jobs, opencode-in-distro checks) and emits
  events to subscribers; `spawnWslSidecar` runs a `wsl bash` script that
  strips `/mnt/*` from PATH, sets `OPENCODE_SERVER_USERNAME/PASSWORD`,
  `XDG_STATE_HOME=$HOME/.local/state`, and execs
  `opencode … serve --hostname 0.0.0.0 --port <free port>`; health is
  polled and failures carry recent output lines. Windows-only; surfaced to
  the app through `WslServersPlatform`.

### Updater

**Files:** `src/main/updater.ts`, `updater-controller.ts`.

- D19. `electron-updater`: channel `latest`, no prereleases, downgrades
  allowed, download and install fully manual; enabled only when packaged
  and channel ≠ dev. State machine + renderer dialog ("restart / later"),
  persisted `ready` record so a pending update survives restarts;
  `quitAndInstall` preserves window ids for restore.

### Build and packaging

**Files:** `electron.vite.config.ts`, `electron-builder.config.ts`,
`scripts/*`.

- D20. electron-vite builds main (`index` + `sidecar` entries; `@lydell/node-pty`
  narrowed to the platform package and externalized; wasm assets copied),
  preload (CJS), and renderer (reuses `@opencode-ai/app/vite`, Sentry
  sourcemaps, app public dir). electron-builder targets: macOS
  `dmg`+`zip` (notarized, hardened runtime, entitlements), Windows `nsis`
  (signed in CI via pwsh script), Linux `AppImage`/`deb`/`rpm` (metainfo,
  legacy `opencode-desktop.desktop` compat entry, StartupWMClass = appId).
  `extraResources` ship the `native/` mac window module and (dev channel
  only) the `opencode-cli` binary; publish targets are the GitHub repos
  `anomalyco/opencode` / `anomalyco/opencode-beta`. Prebuild compiles the
  legacy server node bundle and downloads the CLI for dev.

## packages/ui (`@opencode-ai/ui`)

### Purpose and contract

The shared design-system library for the SolidJS frontends (app, desktop
renderer, enterprise, session-ui, storybook; the TUI consumes only its audio
assets). Published (`access: public`), `sideEffects` limited to CSS. Peers:
`solid-js`, `@solidjs/meta`. Notable deps: `@kobalte/core` (accessible
primitives), `shiki` + `marked` + `katex` (rich text), `@pierre/diffs`
(diff rendering), `motion` (animation), `solid-sonner` (toasts). No
opencode domain dependencies — no sdk/core/server imports.

Exports map (the contract):

| Export | Content |
|---|---|
| `./*` | One module per component (`src/components/*.tsx`) |
| `./context`, `./context/*` | `createSimpleContext`, `DialogProvider`, `FileComponentProvider`, `I18nProvider`, `MarkedProvider` |
| `./hooks` | `createAutoScroll`, `useFilteredList` |
| `./theme`, `./theme/*`, `./theme/context` | Theme types, color math, resolvers, loader, `ThemeProvider` |
| `./i18n/*` | Per-locale dictionaries (62 locales) |
| `./styles`, `./styles/tailwind` | Base + tailwind CSS |
| `./icons/{provider,file-type,app}` | Icon type contracts over generated spritesheets |
| `./fonts/*`, `./audio/*` | Bundled fonts and sounds |
| `./v2/*`, `./v2/*.css`, `./v2/styles/*` | Second-generation component set + v2 CSS variables |
| `./storybook/scaffold`, `./storybook/fixtures` | Story helpers for consumers |

### Components

- U1. `src/components/*` — the primitive inventory: buttons/icon-button,
  select, tabs, accordion, collapsible, checkbox/switch/radio (via kobalte),
  dialog/popover/dropdown/context menus/hover-card/tooltip, text fields and
  inline inputs, lists, cards, tags, progress (+circle), spinners, toasts,
  tooltips, keybind legends, diff-changes, avatars, app/file/provider icons
  (spritesheet-driven), logos/wordmarks, typographic effects
  (typewriter, text-reveal/shimmer/strikethrough), sticky accordion header,
  dock surface. Colocated `.css` files (Tailwind + CSS variables); `.stories.tsx`
  next to each component.
- U2. `src/v2/components/*` — the `-v2` redesign set (button-v2, menu-v2,
  dialog-v2, tabs-v2, segmented-control-v2, file-tree, line-comment,
  project-avatar, wordmark, …) styled against the v2 CSS variables
  (`src/v2/styles/{theme,colors,tailwind}.css`). Both generations coexist;
  the app's new layout consumes v2.

### Contexts

- U3. `createSimpleContext` (`src/context/helper.tsx`) is the shared
  factory: providers gate children on the context's `ready` value and `use`
  throws a named error outside the provider (same pattern as the TUI).
- U4. `DialogProvider` maintains a stack of dialog roots (own owners,
  disposal, close locking); `FileComponentProvider` injects the component
  used to render file references (app supplies session-ui's `File`);
  `MarkedProvider` provides a markdown parser with shiki code highlighting
  (OpenCode theme via `@pierre/diffs` shared highlighter, lazy language
  loading) plus a worker pool and a marked regression test;
  `I18nProvider` bridges the typed app language object into the tree and
  wraps Kobalte's locale provider (`layoutLocale` selects the layout
  direction locale).

### Theme system

**Files:** `src/theme/*` (`types.ts`, `color.ts`, `resolve.ts`,
`v2/resolve.ts`, `context.tsx`, `loader.ts`, `themes/*.json`,
`desktop-theme.schema.json`).

- U5. `DesktopTheme` = `{id, name, light: ThemeVariant, dark: ThemeVariant}`;
  a variant is either seed colors (neutral/primary/success/warning/error/
  info/interactive/diffAdd/diffDelete + ink) or a full palette, plus token
  `overrides` and `v2Overrides`. `resolveThemeVariant` derives complete
  token scales from seeds with OKLCH math (scales, alpha surfaces, blends);
  `themeToCss` emits CSS custom properties; a parallel v2 resolver emits
  the v2 variable set.
- U6. `ThemeProvider` (localStorage: `opencode-theme-id`,
  `opencode-color-scheme`, cached per-mode CSS) applies the theme by
  writing a single `<style id="oc-theme">`: `:root { color-scheme, --… }`,
  sets `data-theme` + `data-color-scheme` on `<html>`, the page background
  (`#080808`/`#fafafa`), the `theme-color` meta, and calls
  `onThemeApplied(theme, mode, scheme)` (desktop uses it to theme the
  native titlebar). 37 bundled themes are lazily glob-loaded; `oc-2` is
  the default and `oc-1` normalizes to it; `system` scheme tracks
  `prefers-color-scheme`; preview overrides are supported. Web hosts inline
  a preload script (`oc-theme-preload`, inlined by `@opencode-ai/app/vite`)
  that applies the cached CSS before first paint.
- U7. External themes can be loaded from URLs (`loader.ts`); the JSON
  shape is documented by `desktop-theme.schema.json`.

### i18n

- U8. Dictionaries for 62 locales (`src/i18n/*.ts`); the English dict is
  the key contract (`UiI18nKey`). `t(key, params)` interpolates
  `{{placeholders}}`; `plural(key, count, params)` selects CLDR plural
  categories via a cached `Intl.PluralRules` (bounded cache of 32) — only a
  fixed set of keys is plural-capable. Missing translations fall back to
  English. Grammar rules from `packages/app/AGENTS.md` (no hardcoded
  English, complete phrases, CLDR-verified terminology) apply to consumers.

### RTL

- U9. Components rely on CSS logical properties (the codebase is
  predominantly logical: ~64 `*-inline`/`inset-inline` uses vs ~10 physical
  `*-left/right`), plus Kobalte's direction-aware primitives driven by the
  bridged locale. No component flips layout itself.

## packages/cli (`@opencode-ai/cli`)

### Purpose

The "OpenCode 2.0 preview" command line interface (package binary name
`lildax`, `bin/lildax.cjs`). It is a thin, Effect-native front end over the
V2 world: it launches the TUI against a managed daemon, serves the V2 API,
and provides service/debug/api utilities. It is explicitly not the legacy
`opencode` CLI (comparison below).

### Framework and commands

**Files:** `src/index.ts`, `src/framework/{spec,runtime}.ts`,
`src/commands/commands.ts`.

- C1. Commands are declared as a spec tree (`Spec.make`, wrapping
  `effect/unstable/cli`) and bound to lazily-imported handlers in
  `src/index.ts`; `Runtime.handler/run` wire subcommands, dynamic imports,
  and the `Daemon.Service` layer. The binary name comes from the
  `OPENCODE_CLI_NAME` define (`lildax` in builds).
- C2. Inventory:
  - `$0` (default) — obtain daemon transport, then run the TUI
    (`src/tui.ts`: `TuiConfig.resolve({}, {terminalSuspend: false})`, empty
    args, no-op plugin host, `gracefulFetch` mapping legacy-endpoint 404s
    (`/config/providers`, `/provider`, `/agent`, `/config`) to empty
    defaults so the TUI boots into provider-connect; provided with
    `AppNodeBuilder.build(Global.node)`). Details: `tui-architecture` R11.
  - `api` — issue an HTTP request to the running server: an OpenAPI
    operation id resolved from the server's `/openapi.json`, or a raw
    `method path`; `-d/--data` body (JSON content-type by default),
    `-H/--header` (≤100), `--param k=v` fills `{path}` templates (extra
    params become query string).
  - `debug agents` — list V2 agents for the CWD as sorted JSON.
  - `migrate` — stub, logs "No migrations to run."
  - `service start|restart|status|stop|password [value]` — manage the
    background server (below).
  - `serve` — start the V2 API server: `--hostname` (default 127.0.0.1),
    `--port` (fallback scan 4096→65535 on bind failure), `--register`
    (publish with the daemon). Serves `createRoutes(password)` from
    `@opencode-ai/server` on a Node HTTP server with
    `Credential.node + PermissionSaved.node` layers, prints
    `server listening on <url>` (no `opencode` prefix — the legacy SDK
    spawner does not parse this entrypoint; see `server-api-sdk`), and
    blocks forever.
- C3. Daemon (`src/services/daemon.ts`), state under `Global.Path.state`:
  - `password` file (0600, atomic temp+rename, base64url random when
    unset; `service password <value>` stops the server before rotating);
  - `server.json` registration `{id, version, url, pid}` (also atomic);
  - `healthy()` = registration decodes + authenticated
    `client.v2.health.get` (2 s timeout) reports healthy;
    `compatible()` additionally requires `version === InstallationVersion`;
  - `start()`: reuse a healthy, version-matching registration only when
    running as a compiled binary (not under `bun`); otherwise stop the
    stale process and spawn a detached, stdio-ignored child
    `<execPath> [entrypoint] serve --register`, then poll `compatible()`
    (100 × 50 ms) for the URL;
  - `stop()`: authenticate first (a stale registration may point at a
    reused PID), then SIGTERM → poll (100 × 50 ms) → re-verify same
    registration → SIGKILL; remove `server.json`;
  - `register(address)` (used by `serve --register`): write registration,
    then a forked 10 s self-check loop that SIGTERMs itself if the file was
    replaced (last-writer wins), plus a scope finalizer removing its own
    registration.
  - `service status` prints `running <url>` or `stopped` — the exact
    format desktop's v2 sidecar discovery parses (D7).

### Build and publish

**Files:** `script/build.ts`, `script/generate.ts`, `script/publish.ts`,
`bin/lildax.cjs`.

- C4. `bun run build` compiles `src/index.ts` with `Bun.build` (`compile`
  mode, solid transform plugin for the TUI) into per-target standalone
  binaries `@opencode-ai/cli-<os>-<arch>[-baseline][-musl]` covering
  linux/darwin/windows × arm64/x64 × (baseline = no-AVX2) × (musl). Defines
  bake in the version (`OPENCODE_VERSION`), binary name, channel, libc, and
  a models.dev snapshot fetched at build time (`OPENCODE_MODELS_DEV` or
  models.opencode.ai). `script/publish.ts` publishes the platform packages
  plus the root launcher package whose `bin/lildax.cjs` picks the right
  platform binary at runtime (AVX2 / musl detection with several fallback
  candidates, `OPENCODE_BIN_PATH` override, signal forwarding).

### Differences from the legacy CLI (`packages/opencode/src/cli`)

| Aspect | Legacy `opencode` | New `lildax` |
|---|---|---|
| Surface | Full legacy command set (`run`, `attach`, `$0` TUI with worker thread, `serve`, `generate`, `auth`, `models`, `update`, …) | Default TUI + `api`, `debug agents`, `migrate` (stub), `service *`, `serve` |
| Backend hosting | In-process worker / `Server.listen` on the legacy composition (`OpenCodeHttpApi` incl. V2 sub-API) | V2-only `createRoutes` from `@opencode-ai/server` |
| TUI transport | RPC-in-process worker, or HTTP with `--port`/attach | Always a daemon-managed HTTP server (version-checked) |
| Auth | `OPENCODE_SERVER_PASSWORD` env / flags | Persisted 0600 password file managed by `service password` |
| Process model | Server lives in the CLI's worker/child | Detached background service reused across invocations |
| Parser/framework | Custom (`packages/opencode` CLI plumbing) | `effect/unstable/cli` spec/handler tree with lazy handlers |
| Distribution | `opencode` npm package / bundles | `@opencode-ai/cli-*` compiled binaries + `lildax` launcher |

## packages/web (`@opencode-ai/web`)

Astro + Starlight documentation/marketing site (deployed on Cloudflare;
`output: "server"`, `@astrojs/cloudflare`, base `/docs`,
`toolbeam-docs-theme`, Solid islands). `src/content/docs` holds the docs
content with per-locale `src/content/i18n`; `src/middleware.ts` performs
locale negotiation (`oc_locale` cookie, `/docs/<locale>/…` aliasing).
`src/pages/s/[id].astro` is the public session-share viewer: a server page
that loads a shared session (typed with the `opencode` workspace package as
a devDependency) and hydrates the Solid `src/components/share/*` renderers
(markdown, code, diff, error, tool parts) against `VITE_API_URL`
(default empty → api.opencode.ai in `dev:remote`). It is a consumer of the
SDK wire types and share backend (`packages/enterprise`), not a client of
the app package.

## Peripheral packages

| Package | Purpose and boundaries |
|---|---|
| `packages/storybook` (`@opencode-ai/storybook`) | Private Storybook (solidjs-vite) harness collecting stories from `ui`, `session-ui`, and `app` with shared decorators (theme/scheme toolbar, dialog + marked providers, tailwind styles) and `mocks/`. Dev tool only; ships nothing. |
| `packages/console` (`@opencode-ai/console-*`) | The opencode.ai website + cloud console deployed with SST: `app` (SolidStart site: marketing, docs, download, changelog, bench, brand, legal, auth/oauth, workspaces, billing/`stripe`, zen/teams pages, share `/s`, desktop feedback, stats), `core` (accounts/actors/billing/drizzle domain services), `function` (handlers), `mail`, `resource`, `support`. Out of scope here: its product behavior. |
| `packages/enterprise` (`@opencode-ai/enterprise`) | SolidStart share service ("Teams" SST stage, deployable to Cloudflare via nitro or Node): Hono API under `/api` (`/share` create with secret, OpenAPI doc at `/api/doc`), `Share` domain (zod-typed session/message/part/diff snapshots) over an aws4fetch S3/R2 storage adapter; the share viewer route. Backs the web `/s/[id]` pages. |
| `packages/identity` | Static brand assets only (logo marks in svg/png); no package.json, no code. |
| `packages/slack` (`@opencode-ai/slack`) | Slack bot (Bolt, socket mode): spawns an embedded opencode server via the legacy SDK `createOpencode` (port 0), maps Slack threads to sessions, posts tool-part updates back to threads. Demo-grade (verbose logging, loose typing). |
| `packages/containers` | CI Docker images for GitHub Actions jobs (`base`, `bun-node`, `rust`, `tauri-linux`, `publish`), built multi-arch via `script/build.ts`. No product code. |
| `packages/function` (`@opencode-ai/function`) | Cloudflare Worker (Hono) exposing a GitHub-app JWT-authenticated publish/sync API over a `SyncServer` Durable Object and R2 bucket for shared session data (session info/message/part snapshots); `jose` + octokit for auth. |
| `packages/codemode` (`@opencode-ai/codemode`) | Effect-native confined execution of a JavaScript subset ("CodeMode programs") over schema-described tools with independent budgets (`timeoutMs`, `maxToolCalls`, `maxOutputBytes`), tool runtime/hooks, stdlib, and OpenAPI-derived tool descriptions; consumed by `packages/opencode`. |
| `packages/http-recorder` (`@opencode-ai/http-recorder`) | Public test utility that records Effect HTTP/WebSocket traffic once and replays deterministic JSON cassettes; used by recorded tests in `core`, `llm`, and `opencode`. Public beta tied to the Effect 4 beta. |
| `packages/httpapi-codegen` (`@opencode-ai/httpapi-codegen`) | Internal HttpApi → client code generator used by `packages/client`; specified in `server-api-sdk`. |
| `packages/stats` | Separate analytics site/service ("stats"): `app` (SolidStart frontend), `core` (Effect services, drizzle schema, stats domains), `function` (Lambda entrypoints), `server` (Docker); distinct deploy from the console. |

## Invariants and constraints

1. Renderer isolation: the desktop renderer never touches Node/Electron
   APIs directly — only `window.api` from `src/preload` (desktop AGENTS.md);
   windows run with `contextIsolation`, `sandbox`, no node integration.
2. One platform abstraction: app code branches on the `Platform` contract,
   never on `window.api` presence, except the declared titlebar/deep-link
   bridge globals (`window.api?.setTitlebar`, `window.__OPENCODE__.deepLinks`).
3. The app must keep working against v1 and v2 servers: every network call
   goes through the compatible-API seam (`createCompatibleApi`) or the
   explicit v1/v2 event split; new code may not bypass it with direct
   version-gated fetches (V1_API_MIGRATION.md tracks removing the v1 side).
4. Server identity changes remount server-scoped subtrees; session changes
   must not (A10) — violating the keying breaks error-reset and lineage
   resolution.
5. Event batching: all server events reach Solid inside the 16 ms batched
   flush with delta coalescing (A16); a path emitting outside the queue is a
   render-perf regression.
6. Credentials: server passwords live in scoped storage / the daemon's 0600
   password file and are never passed as CLI flags or environment variables
   set from user input by these packages; the desktop sidecar password is a
   random UUID delivered over the utility-process `start` message.
7. Daemon safety: PID signaling only after authenticating the registered
   server (C3); registration replacement is last-writer-wins with
   self-verification.
8. `packages/ui` must stay domain-free (no sdk/core/server imports) and
   keep `sideEffects` css-only; published exports are the contract.
9. Theme application must remain synchronous-on-first-paint (preload
   script + `ThemeProvider`); the desktop background/titlebar sync exists
   to hide a flash, not to replace it.
10. i18n rules (app + desktop AGENTS.md): no hardcoded user-visible
    English; pluralization only through the typed plural API; native menus
    re-render from the typed translation bundle.

## Stubs, known limitations

- `packages/cli` `migrate` is a stub ("No migrations to run.").
- Desktop `getDisplayBackend`/`setDisplayBackend` IPC handlers return
  `null`/`undefined` (the Linux wayland backend selector is not
  implemented in main).
- `ServerConnection.Ssh` is declared (and keyed) but nothing constructs it;
  the desktop does not yet manage SSH-proxied servers.
- Desktop `native/` (mac window module referenced by `extraResources`) is
  not checked in; it is produced by the `native:build` script in CI.
- The v2 sidecar path (`OPENCODE_SIDECAR_V2=1`) is opt-in; the default
  desktop server remains the v1 legacy server bundle (D6).
- Session sharing from the app is blocked on a current-API contract
  (`V1_API_MIGRATION.md`); the legacy `/session/:id/share` calls remain
  unmigrated.
- The app still loads files, config, worktrees create/remove, LSP status,
  and instance disposal from legacy endpoints (V1_API_MIGRATION.md
  unchecked items), and keeps legacy `Session/Message/Part` adapters in
  `utils/session*.ts` and `global-sync/utils.ts`.

## Divergences and open questions

- The app depends on a **vendored snapshot** of `@opencode-ai/client`
  (`vendor/opencode-ai-client-1.17.13-v2.tgz`, version 1.17.13) rather than
  the workspace package (which is private/unpublished). Protocol changes
  require re-vendoring; nothing in the repo automates or checks that
  sync.
- Desktop's v2 sidecar downloads `@opencode-ai/cli-*` pinned at
  `0.0.0-next-16350` whose binary is named `opencode2` (staged as
  `opencode-cli`), while the workspace CLI builds/publishes `lildax` — a
  deliberate pinned artifact with name/version skew against HEAD. Who bumps
  the pin, and whether `lildax` and the desktop-bundled CLI converge, is
  unrecorded.
- `packages/cli` serves and shells the V2 world exclusively, but the TUI it
  launches still speaks the legacy bootstrap endpoints through
  `gracefulFetch` 404 shims (see `tui-architecture` "Stubs"); the end state
  (TUI on V2 stores vs shims forever) is not specified here.
- Open questions:
  - Will `service` management grow to multiple daemons (per state home), or
    is the desktop's multi-state-home discovery (D7) a transitional
    compatibility layer?
  - Should the desktop v2 sidecar eventually replace the v1 utility-process
    sidecar entirely (making `packages/opencode/dist/node/node.js` bundling
    unnecessary), and on what timeline?
  - The web entry disables the startup health check (`disableHealthCheck`)
    while desktop keeps it — is a unified connection-gating story intended?
  - `packages/console` vs `packages/stats` vs `packages/enterprise` split
    responsibilities (site, analytics, share) are only documented in their
    READMEs; no spec covers their contracts.

## Dependencies

- `server-api-sdk` — the servers these clients talk to; `serve`/daemon
  mechanics on the server side.
- `tui-architecture` — the TUI the new CLI launches (R11 covers the
  daemon-launch slice).
- `tui-theme` vs `packages/ui` theme system — separate theme engines
  (terminal vs web/desktop); neither consumes the other.
- `config-v1` — legacy config surface still consumed through the app's v1
  compatibility layer.

## Used by

- `packages/app`: desktop renderer, web deploys (app.opencode.ai), e2e
  Playwright suites.
- `packages/desktop`: end users (channel builds).
- `packages/ui`: app, desktop, enterprise, session-ui, storybook, tui
  (audio assets).
- `packages/cli`: developers using the v2 preview; desktop's v2 sidecar
  (published binary form).

## Verification

No formal verification applies. Package checks: `bun typecheck` (tsgo) per
package; `packages/app` unit/browser/playwright suites; `packages/desktop`
`bun test` for main-process modules (window registry, updater controller,
sidecar helpers) plus manual channel packaging; `packages/ui` unit tests
(i18n, marked parser/regression) and storybook smoke; `packages/cli`
`bun test` (`api.test.ts`) and `bun run dev` smoke against a daemon.
