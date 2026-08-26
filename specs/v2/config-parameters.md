# OpenCode V2 Configurable Parameters

Status: draft
Spec source of truth for: the V2 configuration parameter surface — every authored key of the V2 config schema, its responsibility, allowed values, default, implementation status (implemented vs spec-only), and the file topology and merge semantics that produce the effective Location configuration.

## Overview

V2 replaces the V1 aggregate config with a smaller Location-scoped schema
authored in `opencode.json`/`opencode.jsonc` documents (legacy `config.json` is
not discovered). The review ledger config-v2-review decides each legacy group
(keep / remove / redesign); this spec is the resulting parameter reference and
records implementation status against `packages/core`. V1 documents that
contain legacy-only keys are auto-detected and migrated through
`ConfigMigrateV1` before decoding.

## Scope

In: all keys of the implemented V2 root schema (`packages/core/src/config.ts`)
and its sub-schemas, keys decided by the review ledger but not yet implemented
(marked spec-only), V2 config file topology and merge semantics, and the
policy document ordering rules.

Out (non-goals): the V1 surface (see config-v1), the full policy semantics
(see config-v2-policy), catalog/provider domain records beyond their authored
config inputs (see config-v2-provider-model), session runtime behavior that
consumes config (see config-v2-session).

## Definitions

- config-v2/document: an authored `opencode.json`/`opencode.jsonc` file
  contributing to one Location's configuration.
- config-v2/directory-entry: a discovered `.opencode` directory whose resource
  subdirectories (agents, commands, skills, plugins) contribute entries.
- config-v2/location: the open project directory plus its project root; V2
  config is read once per Location open.
- config-v2/entry-list: the ordered list of documents and directory entries
  returned by the V2 config service, lowest priority first.
- config-v2/patch-options: provider/model/agent request options authored as
  partial records (headers, body, aisdk) merged over catalog-supplied
  defaults in document order.

## Interface

### File topology

| Location | Files | Notes |
|---|---|---|
| Global config dir | `opencode.json`, `opencode.jsonc` | Lowest priority; `config.json` not discovered |
| Ancestor directories (location dir → project root) | `opencode.json`, `opencode.jsonc` | Direct documents, closest wins |
| Ancestor `.opencode` directories (closest last) | `opencode.json`, `opencode.jsonc` + resources | Directory entries carry resource subdirectories |

Implementation reads `OPENCODE_DISABLE_PROJECT_CONFIG` to skip project-side
discovery, falling back to global-only (implemented). `OPENCODE_CONFIG`,
`OPENCODE_CONFIG_CONTENT`, managed preferences, and remote org config are V1
loader channels and are not part of the V2 discovery (implemented).

### Root keys

| Key | Type / allowed | Default | Status | Responsibility |
|---|---|---|---|---|
| `$schema` | string | read-only metadata | implemented | Editor validation; V2 never inserts or creates files for it |
| `shell` | string, unvalidated | OS default | implemented | Shell for terminal and shell tool execution |
| `model` | string `provider/model-id` | none | implemented | Fallback model when session/agent has no explicit model |
| `default_agent` | string | `build` | implemented (diverges from review: remove) | Default primary agent |
| `autoupdate` | `true` \| `false` \| `"notify"` | runtime | implemented | Auto-update behavior |
| `share` | `manual` \| `auto` \| `disabled` | runtime | implemented | Session sharing mode |
| `enterprise.url` | string | none | implemented | Legacy enterprise share endpoint |
| `username` | string | OS username | implemented | Display/telemetry identity |
| `permissions` | ordered rule array | none | implemented | Tool permission rules (see below) |
| `agents.<name>` | object | none | implemented | Named agent overrides/definitions |
| `snapshots` | boolean | `true` | implemented | Snapshot tracking for undo/revert |
| `watcher.ignore` | string[] | none | implemented | Filesystem watcher ignore patterns |
| `formatter` | bool \| record | runtime | implemented | Formatter subsystem |
| `lsp` | bool \| record | runtime | implemented | LSP subsystem |
| `attachments.image.{auto_resize,max_width,max_height,max_base64_bytes}` | bool; positive ints | `true`; `2000`; `2000`; `5242880` | implemented | Image normalization limits |
| `tool_output.{max_lines,max_bytes}` | positive ints | `2000`; `51200` | implemented | Truncation thresholds |
| `mcp` | object | none | implemented | MCP subsystem (see below) |
| `compaction` | object | none | implemented | Conversation compaction |
| `skills` | string[] (paths or URLs) | none | implemented | Skill discovery sources |
| `commands.<name>` | object | none | implemented (diverges from review: remove) | Named slash commands |
| `instructions` | string[] | none | spec-only (schema accepts; consumer pending per config-v2-session parity table) | Ambient instruction sources |
| `references.<alias>` | string \| `{path}` \| `{repository, branch?}` | none | implemented | Named external context |
| `plugins` | array of string \| `{package, options?}` | none | implemented | Ordered package plugin load list |
| `providers.<id>` | object | none | implemented | Provider overrides (see below) |
| `experimental.policies` | statement array | none | implemented | Resource policies (see below) |

### Agents (`agents.<name>`)

| Key | Type / allowed | Default | Status |
|---|---|---|---|
| `model` | string | inherited | implemented |
| `variant` | string | none | implemented |
| `request.headers` / `request.body` | string map / any record | none | implemented (authored as config-v2/patch-options) |
| `system` | string | built-in | implemented (renamed from V1 `prompt`) |
| `description` | string | none | implemented |
| `mode` | `subagent` \| `primary` \| `all` | entry-dependent | implemented |
| `hidden` | boolean | `false` | implemented |
| `color` | `#RRGGBB` or theme name | none | implemented |
| `steps` | positive int | model-dependent | implemented |
| `disabled` | boolean | `false` | implemented (renamed from V1 `disable`) |
| `permissions` | rule array | none | implemented |

Agent Markdown discovery from `agent(s)/` and `mode(s)/` in directory entries
is implemented via the config-agent plugin (legacy frontmatter is migrated).

### Permissions (`permissions`)

Ordered array of `{ action: string, resource: string, effect: "allow" | "deny" | "ask" }`
(`PermissionV2.Ruleset`). Matching uses opencode wildcard semantics; rules
apply in order. Top-level rules are extended into every agent's rule list by
the config-agent plugin (implemented). V1 `tools`/`permission` map forms are
migrated to this array shape.

### Providers (`providers.<id>`)

| Key | Type / allowed | Status |
|---|---|---|
| `name` | string | implemented |
| `env` | string[] (credential env names; additive metadata) | implemented |
| `api` | provider API descriptor (aisdk `{type, package, url?, settings}`, or native endpoint forms) | implemented |
| `request.headers` / `request.body` | string map / any record (config-v2/patch-options) | implemented |
| `models.<mid>.family` / `.name` | string | implemented |
| `models.<mid>.api` | `{id?}` + endpoint override (legacy upstream id nests under `api.id`) | implemented |
| `models.<mid>.capabilities` | `{tools, input[], output[]}` | implemented |
| `models.<mid>.request` | headers/body + `variant` | implemented |
| `models.<mid>.variants[]` | `{id, headers?, body?}` | implemented |
| `models.<mid>.cost` | cost object or tiered array; omitted cache prices default to zero | implemented |
| `models.<mid>.disabled` | boolean | implemented |
| `models.<mid>.limit.{context,input,output}` | authored patch (all optional) | implemented |

Not ported per review: provider/model `reasoning`, `temperature`,
`interleaved` flags, `release_date`, `status`, `experimental`, `whitelist`,
`blacklist`, `small_model`, singular `provider`, `enabled_providers`,
`disabled_providers` (migrate to `experimental.policies` per config-v2-policy).

### MCP (`mcp`)

| Key | Type / allowed | Default | Status |
|---|---|---|---|
| `mcp.timeout.startup` | positive int (ms) | runtime | implemented |
| `mcp.timeout.request` | positive int (ms) | runtime | implemented |
| `mcp.servers.<name>.type` | `local` \| `remote` | required | implemented |
| Local `command` | string[] | required | implemented |
| Local `cwd` | string (relative → workspace) | process cwd | implemented |
| Local `environment` | string map | none | implemented |
| `disabled` (both) | boolean | `false` | implemented (replaces V1 `enabled`) |
| `timeout.{startup,request}` per server | positive int patch | subsystem default | implemented |
| Remote `url` | string | required | implemented |
| Remote `headers` | string map | none | implemented |
| Remote `oauth` | `false` \| `{client_id, client_secret, scope, callback_port (1–65535), redirect_uri}` | auto-detect | implemented (snake_case rename from V1) |

### Compaction

| Key | Type / allowed | Default | Status |
|---|---|---|---|
| `compaction.auto` | boolean | `true` | implemented |
| `compaction.prune` | boolean | `false` | implemented |
| `compaction.keep.tokens` | non-negative int | runtime | implemented (replaces V1 `preserve_recent_tokens`) |
| `compaction.buffer` | non-negative int (tokens) | runtime | implemented (replaces V1 `reserved`) |

V1 `compaction.tail_turns` is dropped by the migrator with no V2 equivalent
(gap; see TODO).

### Policies (`experimental.policies`)

Ordered statements `{effect: "allow"|"deny", action, resource}` with wildcard
matching on both `action` and `resource`; the last matching statement wins.
The only implemented action union member is `provider.use`. Authored
documents are consumed in reverse document order (user-global overrides
repository) while statement order inside each document is preserved.
Migration equivalents for `disabled_providers`/`enabled_providers` are
specified in config-v2-policy (spec — semantics implemented for
`provider.use`; migration of the legacy keys is not performed by
`ConfigMigrateV1`, gap).

### Skills (`skills`)

Array of local paths (`~` expanded; relative → Location directory) or HTTP(S)
URLs (served as `index.json` skill lists). Directory entries additionally
contribute `skill/` and `skills/` subdirectories as sources (implemented).
Replaces V1 `skills.{paths,urls}`.

### Instructions (`instructions`)

Array of local paths, glob patterns, or remote URLs supplying automatically
included model context (review: keep). The root key decodes (implemented),
but the configured-source Context Source rows in the config-v2-session parity
table are `missing`/`partial`, so end-to-end consumption is spec-only.

### References (`references`)

Alias map; values are a compact string (`.`, `/`, `~` prefix → local path;
otherwise git repository) or `{path}` / `{repository, branch?, description?,
hidden?}` objects (implemented). Replaces V1 singular `reference`.

### Plugins (`plugins`)

Ordered array of package strings or `{package, options?}` objects. Path-like
packages (`file://`, `./`, `../`) resolve against the declaring document's
directory. Local plugin code is additionally auto-discovered from
`plugin(s)/*.{ts,js}` in directory entries (implemented). Replaces the V1
tuple form.

## Behavior

- R1. V2 discovers `opencode.json`/`opencode.jsonc` in the global config
  directory, in ancestor directories from the Location directory up to the
  project root, and in ancestor `.opencode` directories (implemented).
- R2. The config-v2/entry-list order is: global config documents, then direct
  project documents (closest last), then `.opencode` directory documents —
  general settings first, more specific last; `Config.latest(entries, key)`
  resolves a scalar key from the last document defining it (implemented).
- R3. A document containing any V1-marker key decodes as V1 and is migrated
  through `ConfigMigrateV1` before V2 decoding; migration results are
  in-memory only — the file on disk is not rewritten (implemented).
- R4. Policy statements are gathered from the entry list in reverse order and
  loaded into the Policy service; user-global policy overrides repository
  policy (implemented; see config-v2-policy).
- R5. Configuration is read once per Location open; later reads reuse the
  recorded entry list until the Location is reopened (implemented). Reload/
  watch behavior remains design work per config-v2-catalog-lifecycle.
- R6. JSONC parsing follows the V1 rules (trailing commas allowed, unknown
  keys ignored, original property order preserved); a document that fails to
  parse or decode is silently skipped (implemented).
- R7. Agent Markdown entries: `{agent,agents}/**/*.md` and
  `{mode,modes}/*.md` (modes become `primary`) inside directory entries are
  parsed (frontmatter + body) and merged with `agents` documents; V1
  frontmatter shapes are migrated per-entry (implemented).
- R8. Command Markdown entries: `{command,commands}/**/*.md` inside directory
  entries decode with the same schema as `commands` documents (implemented).
- R9. Provider/model availability remains plugin-driven (models.dev, env,
  account plugins); `providers` documents only override names, env metadata,
  endpoints, request patches, models, and the default model (implemented; see
  config-v2-provider-model).

## Constraints

- One V2 config schema covers global and Location scopes for now; a split is
  deferred until more scope-sensitive fields survive review (per review ledger
  Schema Scope note).
- The `permissions` "ask" effect is interactive and distinct from policies,
  which currently allow only allow/deny (per config-v2-policy).
- Plugin transforms may not add, remove, or override policy statements
  (per config-v2-policy).

## Error handling

- Parse or decode failure of one document skips that document silently (R6);
  it does not abort the Location.

## Dependencies

- config-v1 — V1 key names, legacy normalization, and channel inventory this
  surface migrates from.
- config-v2-review — keep/remove/redesign decisions per legacy group; this
  spec is the parameter reference derived from them, not a duplicate.
- config-v2-policy — policy statement shape, matching, and ordering semantics
  referenced by R4 and the policies table.
- config-v2-provider-model — provider/model/variant option patching and
  catalog interaction for the `providers` tables.
- config-v2-catalog-lifecycle — catalog/config reload lifecycle consuming the
  entry list (R5 defers to it).
- config-v2-session — parity status of config-consuming runtime behavior
  (instructions consumption status).

## Used by

None yet. Specs for consumers of the V2 config surface (session runner,
catalog, TUI) should list config-v2 in their Dependencies when authored.
