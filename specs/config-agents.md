# OpenCode V1 Config and Agents Runtime

Status: stable
Spec source of truth for: the implemented behavior of the V1 configuration/agent/skill/command loading runtime in `packages/opencode` — module responsibilities and contracts, the config discovery-and-merge pipeline, agent schema and resolution, skill/command discovery, and the hot-reload (invalidation/disposal) semantics.

## Overview

`packages/opencode/src/config/` discovers, parses, lowers, and merges JSONC
config documents plus resource directories into one per-project-instance
`ConfigV1.Info` record. `packages/opencode/src/agent/` turns the `agent`/
`mode` portions of that record plus built-in definitions into the runtime
agent registry with resolved permission rulesets. Skills
(`packages/opencode/src/skill/`) and commands
(`packages/opencode/src/command/`) are discovered from overlapping
directory sets and assembled per instance. All of this state is cached in
per-directory `InstanceState` caches; "hot reload" is the disposal of those
caches (triggered explicitly), after which the next access re-runs the full
pipeline.

This spec documents code behavior. The configurable parameter surface
itself — every key, type, default, and channel — is owned by
[config-v1](./config-parameters.md) and is not repeated here.

## Scope

In: `packages/opencode/src/config/` (config, paths, parse, variable,
v2-compat, agent, command, markdown, entry-name, plugin, managed), the V1
schemas in `packages/core/src/v1/config/` they decode against,
`packages/opencode/src/agent/` (registry, built-ins, permission assembly,
subagent permission derivation, generation),
`packages/opencode/src/skill/` (discovery sources, remote pull, registry),
`packages/opencode/src/command/` (command list assembly), and the
instance-lifecycle machinery that reloads them
(`project/instance-store.ts`, `effect/instance-state.ts`,
`effect/instance-registry.ts`, `server/routes/instance/httpapi/lifecycle.ts`,
`server/global-lifecycle.ts`, `cli/tui/worker.ts`).

Out (non-goals): the V1 parameter tables and environment/CLI channels (see
config-v1), the V2 config surface and its review ledger (see config-v2,
config-v2-review), the `tui.json` loader beyond its migration interaction
(`config/tui.ts`, `config/tui-migrate.ts`; see config-v1 R11), provider/model
catalog behavior, plugin host execution beyond config-driven load lists, and
session-runtime consumption of agents (see the session specs).

## Definitions

- config-agents/instance: one project directory context
  (`InstanceContext`: `directory`, `worktree`, `project`) created by
  `InstanceStore.load`; all config/agent/skill/command state is cached per
  instance directory.
- config-agents/instance-state: an `InstanceState.make` scoped cache keyed by
  instance directory (`packages/opencode/src/effect/instance-state.ts`);
  disposal runs registered disposers which invalidate the cache entry.
- config-agents/resource-directory: a directory whose subdirectories
  contribute auto-discovered entries — every entry of
  `ConfigPaths.directories()` (global config dir, ancestor `.opencode`
  directories, `~/.opencode`, `OPENCODE_CONFIG_DIR`).
- config-agents/built-in-agent: an agent defined in code
  (`packages/opencode/src/agent/agent.ts`) with `native: true`.
- config-agents/entry-name: the configuration key derived from a resource
  file's path relative to its resource directory
  (`configEntryNameFromPath`).

## Interface

### Module map — `packages/opencode/src/config/`

| File | Responsibility | Contract |
|---|---|---|
| `config.ts` | `Config.Service`: loads and merges all documents into a per-instance `Info`; global config cache; `update`/`updateGlobal` writers; `invalidate`; `directories`; `waitForDependencies` | `get()` returns the merged instance config or dies with a config error; `getGlobal()` returns the cached global merge; side effects: `$schema` seeding, `.gitignore` creation, background `@opencode-ai/plugin` installs |
| `paths.ts` | `ConfigPaths.files` (direct project doc walk, root-first) and `ConfigPaths.directories` (resource directory list) | `files` reverses the upward walk so the closest document merges last; `directories` does not reverse — closest `.opencode` comes first (see R3) |
| `parse.ts` | `ConfigParse.jsonc` (JSONC parse with line/column errors) and `ConfigParse.schema` (decode with `onExcessProperty: "ignore"`, `propertyOrder: "original"`) | Both throw `JsonError`/`InvalidError` from `packages/core/src/v1/config/error.ts`; unknown keys are dropped, property order preserved |
| `variable.ts` | `ConfigVariable.substitute`: `{env:VAR}` and `{file:path}` expansion before parsing | Env lookup `input.env` then `process.env`, missing → empty string; `~` expansion and resolution against the declaring file's dir (or virtual `dir`); tokens on `//` comment lines left intact; missing file → `InvalidError` unless `missing: "empty"` |
| `v2-compat.ts` | `ConfigV2Compat.lower`: lowers V2-shaped keys (`agents`, `commands`, `skills[]`, `snapshots`, `media`, `mcp.servers`, `compaction.keep/buffer`, `model` with `#variant`, `lsp` entries) onto the V1 shape | Returns `{value, diagnostics}`; diagnostics (invalid/unsupported/conflict) are logged as warnings, not fatal; presence of any V2 `permissions` key (top-level or inside an agent entry) is a fatal `InvalidError` |
| `agent.ts` | `ConfigAgent.load(dir)` / `loadMode(dir)`: agent and mode Markdown discovery | `{agent,agents}/**/*.md` and `{mode,modes}/*.md` (dot files and symlinks followed); body or frontmatter `prompt` gets `{file:}`/`{env:}` directives resolved; see R14 for failure behavior |
| `command.ts` | `ConfigCommand.load(dir)`: command Markdown discovery | `{command,commands}/**/*.md`; body becomes `template` with directives resolved; decode failure throws `InvalidError` (fatal for the instance) |
| `markdown.ts` | `ConfigMarkdown`: frontmatter parse wrapper over `packages/core/src/config/markdown.ts` + `FILE_REGEX`/`SHELL_REGEX` template helpers | Throws `FrontmatterError` on unparseable YAML; permissive fallback for foreign-agent colon-tolerant frontmatter lives in core |
| `entry-name.ts` | `configEntryNameFromPath(relativePath, prefixes)` | Strips one anchored prefix (`agent/`, `agents/`, `command/`, …), strips the extension, keeps inner path segments (`agents/foo/bar.md` → `foo/bar`); anchored on the relative path so home-directory segments cannot mis-key (#25713) |
| `plugin.ts` | `ConfigPlugin.load(dir)` (`{plugin,plugins}/*.{ts,js}` → `file://` specs), `resolvePluginSpec` (path-like specs resolved against the declaring file), `deduplicatePluginOrigins` | Dedupe identity: npm package name for npm specs, exact `file://` URL for local specs; later declarations win and keep their `Origin {spec, source, scope}` |
| `managed.ts` | `ConfigManaged`: platform managed directory (`/Library/Application Support/opencode`, `%ProgramData%\opencode`, `/etc/opencode`) and macOS MDM plist reading via `plutil` | Plist profile metadata keys (`Payload*`, `_manualProfile`) stripped before parsing |
| `tui.ts`, `tui-migrate.ts`, `tui-host-attention.ts`, `tui-cwd.ts` | `tui.json`/`tui.jsonc` loading for the TUI process | Out of scope here; see config-v1 (TUI table, R11–R12) |

### Module map — schemas, `packages/core/src/v1/config/`

| File | Responsibility |
|---|---|
| `config.ts` | Root `ConfigV1.Info` schema (all V1 keys; see config-v1 tables) |
| `agent.ts` | `ConfigAgentV1.Info`: `StructWithRest` — known agent keys plus any rest keys; decode-time `normalize` folds unknown keys into `options`, converts `tools` booleans to `permission` (write/edit/patch → edit; explicit `permission` wins), and falls back `steps ?? maxSteps` |
| `command.ts`, `skills.ts`, `permission.ts`, `plugin.ts`, `provider.ts`, `mcp.ts`, … | Sub-schemas for their config-v1 table sections |

### Module map — `packages/opencode/src/agent/`

| File | Responsibility | Contract |
|---|---|---|
| `agent.ts` | `Agent.Service`: per-instance agent registry — built-ins, config overrides, permission assembly, `get`/`list`/`defaultInfo`/`defaultAgent`, and `generate` (LLM agent authoring used by `opencode agent generate`) | `get(name)` returns `Info \| undefined`; `list()` sorts (default first, then name asc); `defaultInfo()` throws on an invalid configured `default_agent` (R16) |
| `subagent-permissions.ts` | `deriveSubagentSessionPermission` for task-tool spawns | Parent session keeps only its `external_directory` rules and deny rules; adds `todowrite`/`task` denies unless the subagent's own ruleset already grants them |
| `prompt/*.txt`, `generate.txt` | Built-in agent prompts (explore, compaction, summary, title) and the generation prompt | Imported at build time; the only built-in prompts shipped as data |

### Module map — skills and commands

| File | Responsibility | Contract |
|---|---|---|
| `skill/index.ts` | `Skill.Service`: discovery sources, `SKILL.md` parsing, registry, `get`/`require`/`all`/`dirs`/`available(agent)` | Registry is last-writer-wins by frontmatter `name`; `available` filters by `Permission.evaluate("skill", name, agent.permission)` |
| `skill/discovery.ts` | `Discovery.Service.pull(url)`: fetch `index.json`, download into `Global.Path.cache/skills/<name>`, version-staged swaps | Skills missing `SKILL.md` are warned and skipped; versioned skills refresh via staging dir + atomic rename with backup rollback |
| `command/index.ts` | `Command.Service`: assembles the slash-command list from built-ins, config `command` entries, MCP prompts, and skills | Precedence: built-in < config < MCP prompts < (skills only fill unused names); `template` may be a lazy `Promise` (MCP) |

### Module map — instance lifecycle (reload machinery)

| File | Responsibility |
|---|---|
| `project/instance-store.ts` | `InstanceStore.Service`: load/reload/dispose/disposeAll of per-directory instances; emits `server.instance.disposed` |
| `project/bootstrap.ts` | `InstanceBootstrap`: per-instance init — config eager load, plugin init (plugins may mutate config), LSP/share/format/vcs/snapshot/project init |
| `effect/instance-state.ts` | `InstanceState.make`: ScopedCache keyed by directory; registers a disposer that invalidates the entry |
| `effect/instance-registry.ts` | Process-global disposer set; `disposeInstance(directory)` runs all registered disposers |
| `server/routes/instance/httpapi/lifecycle.ts` | `markInstanceForDisposal` / `markInstanceForReload` — deferred teardown/reboot after the HTTP response is sent |
| `server/global-lifecycle.ts` | `disposeAllInstancesAndEmitGlobalDisposed` — dispose every instance, then emit the global `server.instance.disposed` |
| `server/routes/instance/httpapi/middleware/instance-context.ts` | Per-request `InstanceStore.load({directory})` + `InstanceRef` provision |
| `cli/tui/worker.ts`, `cli/cmd/tui.ts` | TUI worker RPC surface incl. `reload()`; the TUI process wires `SIGUSR2` to it |

## Behavior

### Config discovery and merge

- R1. Instance config load order (`Config.loadInstanceState`,
  `packages/opencode/src/config/config.ts`); later sources win on conflict:
  (a) remote well-known config per authenticated server
  (`<origin>/.well-known/opencode` → inline `config` merged with
  `remote_config.{url,headers}` document; substitution uses auth-derived
  env; HTML response → `RemoteAuthError`; fetch/decode failure is fatal),
  (b) global config files — `config.json`, then `opencode.json`, then
  `opencode.jsonc` in `Global.Path.config` (all three load if present;
  a legacy `config/` TOML file, when present, is migrated to
  `config.json` and removed), (c) the `OPENCODE_CONFIG` file,
  (d) direct project documents
  from `ConfigPaths.files` — worktree-root first, closest to the working
  directory last, (e) the resource-directory loop over
  `ConfigPaths.directories()` — for `.opencode` directories and
  `OPENCODE_CONFIG_DIR` also merging their `opencode.json` then
  `opencode.jsonc`, plus auto-discovered command/agent/mode Markdown and
  local plugins from every directory, (f) `OPENCODE_CONFIG_CONTENT`
  (virtual source, plugin scope local), (g) active-organization console
  config (`<account url>/api/config`, non-fatal on failure; sets
  `OPENCODE_CONSOLE_TOKEN`), (h) managed-directory `opencode.json{,c}`,
  (i) macOS managed preferences (highest).
- R2. Merging is `mergeDeep` per key; arrays replace, except `instructions`
  which concatenates and dedupes across documents
  (`mergeConfigConcatArrays`). Plugin lists additionally re-track origins:
  `plugin` becomes the deduplicated spec list while `plugin_origins`
  (derived state, stripped before writing) keeps each winning spec's source
  file and scope.
- R3. Directory iteration asymmetry (from `ConfigPaths` +
  `FSUtil.up` walk order): direct project documents are merged root-first
  so the document closest to the working directory wins, while resource
  directories (and the `opencode.json{,c}` inside `.opencode`
  directories) are iterated closest-first — global config dir, then
  `.opencode` from the working directory up to the worktree root, then
  `~/.opencode`, then `OPENCODE_CONFIG_DIR` — so an ancestor `.opencode`
  overrides a nested one, and `OPENCODE_CONFIG_DIR` overrides both for
  discovered resources and `.opencode` documents. Auto-discovered
  agent/command entries from a later directory deep-merge over earlier
  ones by entry name.
- R4. Within a single directory, both files load when both exist, and the
  per-scope order differs: global is `config.json` < `opencode.json` <
  `opencode.jsonc` (jsonc wins); direct project documents list
  `opencode.jsonc` before `opencode.json` per directory (json wins);
  `.opencode`/`OPENCODE_CONFIG_DIR` directories load `opencode.json` then
  `opencode.jsonc` (jsonc wins).
- R5. Per document: `ConfigVariable.substitute` runs on the raw text
  (module-map contract above; virtual sources substitute against their
  `dir`), then `ConfigParse.jsonc` (trailing commas allowed), then
  `ConfigV2Compat.lower(normalizeLoadedConfig(parsed))` — which strips
  legacy `theme`/`keybinds`/`tui` keys, lowers V2 shapes, and hard-fails
  on V2 `permissions` — then `ConfigParse.schema(ConfigV1.Info)`.
  Lowering diagnostics are logged as warnings. For file-backed documents a
  missing `$schema` is inserted once by rewriting the file (best effort);
  the global default file is seeded with `{"$schema": ...}` when it does
  not exist and no config env routing is set.
- R6. Path-like plugin specs (`./`, `../`, absolute, `file://`) are
  resolved against the declaring file's directory at load time
  (`resolveLoadedPlugins`), never a later merge location. Plugin scope for
  origins: `http(s)` sources and the global config dir → global;
  `OPENCODE_CONFIG_CONTENT` and sources inside the instance
  directory/worktree → local.
- R7. Post-merge normalization (`loadInstanceState` tail):
  `mode` entries deep-merge into `agent` with `mode` forced to
  `"primary"` (an entry's own `mode` value is overridden);
  `OPENCODE_PERMISSION` (JSON) deep-merges over file-derived
  `permission` (invalid JSON → warning, skipped); top-level `tools`
  booleans convert to `permission` (write/edit/patch → edit) under
  explicit `permission`; `username` falls back to `os.userInfo().username`
  then `"user"`; `autoshare: true` without `share` sets
  `share: "auto"`; `OPENCODE_DISABLE_AUTOCOMPACT` forces
  `compaction.auto: false`; `OPENCODE_DISABLE_PRUNE` forces
  `compaction.prune: false`. Agent-level `tools`/`steps`/unknown-key
  normalization happens earlier, inside the `ConfigAgentV1.Info` decode.
- R8. Loading an instance seeds side effects in every resource directory:
  a `.gitignore` (ignoring `node_modules`, package files, `.gitignore`)
  is created when absent (PermissionDenied tolerated), and a background
  npm install of `@opencode-ai/plugin` is forked per directory
  (`deps` fibers; `waitForDependencies()` joins them; plugin loading
  calls it before loading external plugins).
- R9. Writers: `update(config)` merges into `<instance directory>/config.json`
  (reads the existing file if present) — note this filename is discovered
  only at global scope (D4). `updateGlobal(config)` patches the existing
  global file in place — JSONC-aware `jsonc-parser` edits for `.jsonc`,
  pretty-printed JSON otherwise — validates the result by decoding it, and
  writes only when content changes; `shell: ""` is dropped instead of
  persisted. On change it calls `invalidate()`.
- R10. Caching: the global merge is cached process-wide with infinite TTL
  until `Config.invalidate()`; the instance merge is an `InstanceState`
  keyed by directory. `Auth`-derived env is threaded into global loads only
  for the instance load (the shared global cache is used when no auth
  entries exist).

### Agent configuration and resolution

- R11. Schema (`ConfigAgentV1.Info`): known keys `model`, `variant`,
  `temperature`, `top_p`, `prompt`, `description`, `mode`
  (`subagent|primary|all`), `hidden`, `disable`, `color` (`#RRGGBB` or the
  seven theme names), `steps` (positive int; `maxSteps` deprecated
  fallback), `tools` (deprecated), `permission`, `options`; all unknown
  keys fold into `options` at decode time. Runtime `Agent.Info`
  (`packages/opencode/src/agent/agent.ts`) carries the resolved form:
  `model` parsed into `{providerID, modelID}`, `top_p` → `topP`,
  `permission` as a flat `PermissionV1.Ruleset`.
- R12. Built-in agents (all `native: true`, permission =
  `Permission.merge(defaults, <agent-specific>, <user config>)`):
  `build` (primary; question + plan_enter allowed), `plan` (primary;
  question + plan_exit allowed, `task general` denied, plan-file edits
  allowed under `Global.Path.data/plans/*` and
  `.opencode/plans/*.md`), `general` (subagent; todowrite denied),
  `explore` (subagent, custom prompt; everything denied except
  grep/glob/list/bash/webfetch/websearch/read and read-only external
  directories), `compaction`, `title` (temperature 0.5), `summary`
  (hidden primaries; everything denied). The shared `defaults` ruleset:
  `* → allow`, `doom_loop → ask`, `external_directory * → ask` with
  allows for the truncation glob, the process temp glob, every discovered
  skill directory, and every configured reference directory (references
  resolve after waiting for the `core/config-reference` plugin),
  `question/plan_enter/plan_exit → deny`, and `read` asking for
  `*.env`/`*.env.*` except `*.env.example`.
- R13. Config overrides (`cfg.agent` entries applied in insertion order):
  `disable: true` deletes the agent (built-in or custom); an unknown name
  creates a custom agent (`mode: "all"`, `defaults`+user permission,
  `native: false`); otherwise fields override the built-in/custom entry —
  `model` parsed, `variant`/`prompt`/`description`/`temperature`/
  `top_p`/`mode`/`color`/`hidden`/`name`/`steps` replaced when present,
  `options` deep-merged, and the entry's `permission` merged after the
  existing ruleset (later rules win at evaluation). Afterwards every
  agent's ruleset is extended with an allow for the truncation glob
  unless it explicitly denies that glob.
- R14. Discovery failure behavior: agent Markdown that fails YAML
  frontmatter parsing is logged and skipped; an agent entry that decodes
  against `ConfigAgentV1.Info` with schema errors throws `InvalidError`
  (fatal for the instance). Mode Markdown is the lenient twin: both parse
  and decode failures silently skip the file. Command Markdown parse
  failures are skipped, but decode failures throw `InvalidError` (fatal).
- R15. Entry names: agent files key on the path under `agent(s)/`
  (extension stripped, nested segments kept); modes key on the file
  basename under `mode(s)/`; commands key on the path under
  `command(s)/`.
- R16. `defaultInfo()`: with `default_agent` configured, the agent must
  exist, not be a subagent, and not be hidden — otherwise an `Error` is
  thrown (D1). Without it, the first visible non-subagent agent in
  registry insertion order wins (`build`, then `plan`, …, customs).
  `list()` sorts the default candidate (`default_agent` or `build`)
  first, then name ascending.
- R17. Subagent sessions spawned via the task tool use
  `deriveSubagentSessionPermission`: the parent session's deny rules and
  `external_directory` rules carry over (parent restrictions on other
  tools do not — the subagent's own ruleset governs), and `todowrite`/
  `task` are denied unless the subagent's own ruleset names them.
- R18. `Agent.generate` produces `{identifier, whenToUse, systemPrompt}`
  via `generateObject`/`streamObject` against the default or given model,
  using `agent/generate.txt` as the system prompt and excluding existing
  agent names. The `opencode agent generate` CLI writes the result as
  frontmatter Markdown to `.opencode/agents/<id>.md` (project) or
  `<global config>/agents/<id>.md` (global scope).

### Skills

- R19. Discovery sources, scanned in order (matches deduplicated across
  sources by absolute path): `~/.claude` and `~/.agents` then ancestor
  `.claude`/`.agents` directories (pattern `skills/**/SKILL.md`; skipped
  under `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `.claude` also under
  `OPENCODE_DISABLE_CLAUDE_CODE[_SKILLS]`); every resource directory
  (`{skill,skills}/**/SKILL.md`); `skills.paths` entries (`~` expanded,
  relative to the instance directory; missing → warning); `skills.urls`
  entries via `Discovery.pull` into the cache. Scan failures in external
  scopes log and continue; failures in opencode directories are defects.
- R20. Remote pull: fetch `<url>/index.json`
  (`{skills: [{name, files, version?}]}`); entries without `SKILL.md` are
  warned and skipped; files resolve against `<host>/<skill name>/` and
  download into `Global.Path.cache/skills/<name>` (concurrency 4 skills,
  8 files). A versioned skill whose cached `.opencode-version` differs
  downloads into a staging directory, then swaps atomically with backup
  and rollback; an unversioned skill only downloads missing files. A dir
  counts only if `SKILL.md` exists.
- R21. Registration: a `SKILL.md` must parse and carry frontmatter
  `name: string` (+ optional `description`); content gets `{file:}`/
  `{env:}` directives resolved against the file's directory (failures
  fall back to raw content). Frontmatter parse failure publishes a
  session error event and skips the file; a file whose frontmatter lacks
  a valid `name` is silently skipped; a duplicate name logs a warning and
  the later match wins. The built-in `customize-opencode` skill is
  registered before disk discovery, so a disk skill with the same name
  overrides it.
- R22. `Skill.dirs()` (every directory containing a discovered `SKILL.md`)
  feeds the agent `external_directory` allowlist (R12), making skill
  companion files readable without permission prompts;
  `Skill.available(agent)` filters the registry by the agent's `skill`
  permission rules.

### Commands

- R23. Assembly order (`Command.state`, per instance): built-in `init`
  (guided AGENTS.md setup) and `review` (subtask; commit/branch/pr
  review), then config `command` entries — the `command` map from merged
  documents plus command Markdown discovered during config load (later
  directories overriding by name) — then MCP prompts (overriding
  same-named config commands; template resolved lazily through the MCP
  client with `$N` argument placeholders), then skills filling only names
  no earlier source took (template = skill content plus a base-directory
  footer). `hints` derives `$ARGUMENTS`/`$N` placeholders from the
  template; `subtask`, `agent`, `model`, `variant`, `description` pass
  through from config.

### Hot reload

- R24. All config-derived state (config instance merge, agent registry,
  skill discovery and registry, command list, permission session state)
  lives in per-directory `InstanceState` caches. An instance is created by
  `InstanceStore.load` (per HTTP request via
  `InstanceContextMiddleware`, or explicitly); creation runs
  `InstanceBootstrap` (config eager-load, plugin init — plugins can
  mutate config, then LSP/share/format/vcs/snapshot/project init).
- R25. Reload triggers (all explicit; there is no filesystem watcher on
  config files in the V1 runtime — D5):
  - `SIGUSR2` to the TUI process → worker RPC `reload` →
    `Config.invalidate()` + `disposeAllInstancesAndEmitGlobalDisposed`.
  - HTTP `global/config` update → `updateGlobal` → on change:
    invalidate + dispose all instances (forked after the response).
  - HTTP instance `config` update → `Config.update` writes
    `<instance>/config.json`, then `markInstanceForDisposal` disposes that
    instance after the response.
  - HTTP instance `dispose` endpoint; `InstanceStore.reload(input)`
    (dispose + reboot one directory; used by the project `init-git`
    endpoint via `markInstanceForReload` when VCS identity changes).
  - PTY close handlers invalidate the `LocationServiceMap` entry for a
    directory.
- R26. Disposal runs the process-global disposers for that directory
  (`instance-registry`), which invalidate every `InstanceState` entry
  (scoped finalizers also run — e.g. pending permission asks are
  rejected), emits `server.instance.disposed` for the directory (and the
  global event for dispose-all), and removes the `InstanceStore` cache
  entry. The next request re-boots the instance and re-runs the entire
  pipeline: documents re-read from disk, agent/skill/command state
  rebuilt, remote skill indexes re-pulled, MCP prompts re-listed.
- R27. `Config.invalidate()` clears only the process-wide global-config
  cache; instance merges are refreshed solely through instance disposal
  (R25–R26). `updateGlobal` invalidates only when the written content
  changed.

## Constraints

- Permission rule order is significant: evaluation is `findLast` over the
  concatenated ruleset (`Permission.evaluate`), so later rules (user
  config after built-in defaults, entry permission after inherited) win;
  `~/` and `$HOME` prefixes in config patterns expand to the home
  directory.
- Config decode failure is fatal for the loading instance (`orDie`):
  JSONC parse errors, schema decode errors, V2 `permissions` presence,
  missing `{file:}` references, and command/agent Markdown schema errors
  all abort instance creation. Skills and mode files are individually
  skip-on-error; the built-in `customize-opencode` skill is always
  present.
- `plugin_origins` is derived state: it is stripped by
  `writable()`/`writableGlobal()` before any write and never persisted.
- The `mode` container cannot produce non-primary agents (R7); `hidden`
  is only meaningful for subagents (it hides from `@` autocomplete).
- `Agent.state` depends on `Skill.dirs()` and (when `references` are
  configured) on the `core/config-reference` plugin having produced
  reference paths before permission defaults can be assembled.
- Remote config from authenticated servers is merged with `authEnv`
  credentials; the shared global cache is bypassed for that instance
  load (R10).

## Error handling

| Condition | Behavior |
|---|---|
| JSONC parse failure | `JsonError` with path, line/column, offending input — fatal for the instance |
| Schema decode failure | `InvalidError` with per-path issues — fatal |
| V2 `permissions` key present | `InvalidError` naming the paths — fatal ("run opencode2") |
| `{file:}` reference missing | `InvalidError` naming token and resolved path — fatal (TUI loader: empty) |
| Remote well-known fetch failure / HTML body | Fatal (die); HTML raises `RemoteAuthError` naming the login origin — the legacy HTTP error middleware maps it to a structured 400 body, and the TUI renders it as a re-auth hint (`opencode auth login <url>`) with exit code 1 |
| Active-org console config failure | Logged (debug), skipped — non-fatal |
| Agent Markdown YAML failure | `console.error`, file skipped — non-fatal |
| Agent entry schema failure | `InvalidError` — fatal |
| Mode Markdown any failure | Silently skipped |
| Command Markdown schema failure | `InvalidError` — fatal |
| Skill frontmatter failure | Session error event + log, file skipped |
| Skill without valid `name` frontmatter | Silently skipped |
| Duplicate skill name | Warning logged, later file wins |
| `OPENCODE_PERMISSION` invalid JSON | Warning, env merge skipped |
| Invalid `default_agent` (unknown/subagent/hidden) | `Error` thrown from `defaultInfo()` at use time |

## Divergences and open questions

- D1. `default_agent` set to an invalid value throws from
  `Agent.defaultInfo()` at use time; it does not fall back to `build`.
  The schema description and config-v1's key table ("invalid value falls
  back to `build`") describe the unset case only, where the first visible
  primary (normally `build`) is selected. Code/spec divergence against
  config-v1's table wording.
- D2. Per-directory filename precedence is inconsistent across scopes
  (R4): global favors `opencode.jsonc`, direct project documents favor
  `opencode.json`, `.opencode` directories favor `opencode.jsonc` again.
  Config-v1 R1 does not state per-directory tie-breaking.
- D3. Resource-directory iteration is closest-first (R3), so ancestor
  `.opencode` resources override nested ones — the opposite direction of
  direct documents, where the closest wins. Surprising but implemented;
  config-v1 R1(e) says only "in directory discovery order".
- D4. `Config.update` (instance-scoped HTTP config update) writes
  `<instance directory>/config.json`, a filename project discovery never
  reads (project walk targets `opencode.json{,c}` only; `config.json` is
  read solely from the global config dir). Persisted instance config
  therefore does not survive instance re-boot through discovery. Open
  question: intended legacy behavior or bug.
- D5. Hot reload is explicit-only (R25). The core `FileWatcher`
  (`packages/core/src/filesystem/watcher.ts`, gated by
  `OPENCODE_EXPERIMENTAL_FILEWATCHER`) publishes file events but does not
  trigger V1 config reloads; editing `opencode.json` or `.opencode/`
  resources takes effect only after a dispose/reload trigger (or process
  restart).
- D6. Mode Markdown is silently skipped on any failure while the
  equivalent agent Markdown fails the instance on schema errors (R14) —
  an intentional-looking but undocumented asymmetry.

## Dependencies

- config-v1 — owns the parameter tables (keys, types, defaults, channels,
  file topology summary, TUI surface) this runtime implements; R-numbered
  merge/substitution rules there (R1–R15) correspond to R1–R10 here at
  code level.
- config-v2 / config-v2-review — the V2 surface that replaces this
  runtime in `packages/core`; `ConfigV2Compat` (this spec, R5) is the V1
  side of that boundary.
- config-v2-catalog-lifecycle — owns reload-lifecycle design work; this
  spec records the implemented V1 behavior that design starts from.

## Used by

- None yet. Specs consuming agent resolution or the reload machinery
  (session runtime, TUI sync, plugin host) should reference this spec for
  module contracts and hot-reload semantics.
