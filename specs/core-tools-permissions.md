# Core Tools & Permissions (V1)

Status: draft
Reference: core-tools-permissions
Spec source of truth for: the legacy (V1) tool system (`packages/opencode/src/tool/`) and permission flow (`packages/opencode/src/permission/`) — for anyone changing built-in tools, plugin/custom tool registration, or permission evaluation.

## Overview

This spec describes the behavior of the V1 tool pipeline in `packages/opencode`:
how a tool is defined (`Tool.define`), wrapped (decode → execute → output
bounding), registered (`ToolRegistry`), advertised per model/agent
(`ToolRegistry.tools`), invoked from the session loop (`SessionTools.resolve` →
AI SDK `tool()`), and how every privileged action gates through the V1
permission service (`Permission.Service`: rule evaluation, ask/reply lifecycle,
runtime approvals, events, HTTP surface).

## Scope

In: `packages/opencode/src/tool/**` (tool definitions, registry, truncate,
json-schema helper, shell parsing/prompt, external-directory guard) and
`packages/opencode/src/permission/**` (evaluate, ask/reply service, arity
table); the call path through `src/session/tools.ts`, `src/session/llm.ts`,
`src/session/llm/request.ts`, and `src/session/processor.ts` as far as tool
calls and permission outcomes are concerned; permission rule sources (agent
defaults, user config `permission`, session `tools` map, per-session rules).

Out (non-goals): the V2 tool type, registry, and `PermissionV2`
(`packages/core/src/tool*`, `packages/core/src/permission.ts`) — specified by
`specs/v2/tools.md`; MCP client lifecycle (`src/mcp`) except the tool-call
wrapping; the `Question` service internals (same deferred pattern as
permissions, see `src/question`); TUI rendering of permission prompts; the LSP
service; provider transport.

## Relationship to existing specs

- `specs/v2/tools.md` (v2-tools, draft) specifies the future V2 tool
  registration/execution model. It is a design spec for `packages/core`; this
  document specifies the V1 system that `packages/opencode` runs today. Where
  the two overlap conceptually (bounding, failure semantics), V1 behavior is
  intentionally different and noted here, not reconciled.
- `packages/opencode/specs/effect/tools.md` (effect-tools, draft) tracks the
  Effect migration state of `src/tool` files. Its file inventory is stale
  relative to this branch (see Divergences below); this spec is the behavioral
  source of truth, that one remains the migration ledger.
- `specs/tool-interactive.md` (tool-interactive, draft) designs the V2
  `interactive` process tool family. It cites this spec's bash permission
  precedent (ask on the full command text; `external_directory` for outside
  working directories) but targets `PermissionV2` in `packages/core` and does
  not change the V1 tool system specified here.
- `specs/discard-context.md` (core-discard-context, stable) specifies the
  `discard_context` tool, its config gate, and marked-part history filtering
  in both runtimes. Its V1 wrapper is a built-in of this registry (T1), asks
  no permission (P4), and stays subject to the doom-loop guard (R23).
- `packages/opencode/specs/effect/instance-context.md` covers the
  `InstanceState` per-directory conventions used by the registry and permission
  state.

## Key files

| File | Responsibility | Contract |
|---|---|---|
| `packages/opencode/src/tool/tool.ts` | Tool type and definition helper | `Tool.define(id, init)` → `Info`; `Tool.init(info)` returns a `Def` whose `execute` decodes args, runs the tool, applies output truncation |
| `packages/opencode/src/tool/registry.ts` | Built-in + custom + plugin tool registry | `ids()/all()/named()/tools(model)`; per-instance state; model/flag gating; `tool.definition` plugin hook |
| `packages/opencode/src/tool/truncate.ts` | Model-facing output bounding | `Truncate.output(text, opts, agent)` → preview + retention file; limits from config `tool_output` |
| `packages/opencode/src/tool/truncation-dir.ts` | Truncation directory constant | `Global.Path.data/tool-output` |
| `packages/opencode/src/tool/json-schema.ts` | Effect Schema → JSON Schema for tools | `fromSchema`/`fromTool` with reference inlining and AI-SDK-friendly normalization |
| `packages/opencode/src/tool/schema.ts` | `ToolID` branded id (`tool_…`) | Used for truncation file names |
| `packages/opencode/src/tool/read.ts`, `edit.ts`, `write.ts`, `apply_patch.ts`, `glob.ts`, `grep.ts`, `task.ts`, `webfetch.ts`, `websearch.ts`, `skill.ts`, `todo.ts`, `lsp.ts`, `discard-context.ts` | Built-in tool definitions | One `Tool.define` export each; ask permission before side effects (`discard_context` asks none) |
| `packages/opencode/src/tool/shell.ts` + `shell/` | Shell tool (`id: "bash"`), tree-sitter command scan, prompt rendering | Asks `external_directory` then `bash` permissions; streams output with truncation spool |
| `packages/opencode/src/tool/question.ts`, `plan.ts` | Interactive tools | Use `Question.Service`, not `ctx.ask` |
| `packages/opencode/src/tool/invalid.ts` | Fallback tool (`id: "invalid"`) | Returns the repair error text as a successful tool result |
| `packages/opencode/src/tool/code-mode.ts` | Experimental `execute` tool | Confined interpreter over visible MCP tools |
| `packages/opencode/src/tool/external-directory.ts` | Outside-worktree guard | `assertExternalDirectoryEffect(ctx, path)` asks `external_directory` |
| `packages/opencode/src/tool/mcp-websearch.ts` | MCP-style HTTP client for websearch providers | JSON-RPC `tools/call` over `HttpClient` |
| `packages/opencode/src/permission/index.ts` | Permission service + rule helpers | `ask/reply/list`; `evaluate`, `merge`, `fromConfig`, `disabled`, `visibleTools` |
| `packages/opencode/src/permission/arity.ts` | Shell command arity table | `BashArity.prefix(tokens)` → "human command" prefix |
| `packages/opencode/src/permission/evaluate.ts` | Re-export of `evaluate` | Import site for `truncate.ts` |
| `packages/schema/src/v1/permission.ts` | Wire schema | `Rule`, `Ruleset`, `Request`, `Reply`, `AskInput`, events |
| `packages/core/src/v1/permission.ts` | Error classes | `RejectedError`, `CorrectedError`, `DeniedError`, `NotFoundError` |
| `packages/core/src/v1/config/permission.ts` | Config schema | `permission` key shape (`action` or `{pattern: action}`) |
| `packages/core/src/util/wildcard.ts` | Pattern matcher | `*`, `?`, literal `.`; `\`→`/`; case-insensitive on Windows |

## Behavior

### T1 — Tool inventory

Built-in `Tool.Def` ids produced by the registry
(`packages/opencode/src/tool/registry.ts`), in builtin-list order:

| Model-facing id | File | Permission key asked | Notes |
|---|---|---|---|
| `invalid` | `invalid.ts` | — | Repair fallback; always present |
| `question` | `question.ts` | — (Question service) | Only when `flags.client ∈ {app, cli, desktop}` or `enableQuestionTool` |
| `bash` | `shell.ts` | `bash` + `external_directory` | Id kept `"bash"` for compat (`shell/id.ts`); rename planned for 2.0 |
| `read` | `read.ts` | `read` + `external_directory` | |
| `glob` | `glob.ts` | `glob` | |
| `grep` | `grep.ts` | `grep` | |
| `edit` | `edit.ts` | `edit` + `external_directory` | Hidden for `gpt-*` (non-`oss`, non-`gpt-4`) models |
| `write` | `write.ts` | `edit` + `external_directory` | Same model gating as `edit` |
| `task` | `task.ts` | `task` | |
| `webfetch` | `webfetch.ts` | `webfetch` | |
| `todowrite` | `todo.ts` | `todowrite` | |
| `websearch` | `websearch.ts` | `websearch` | Only when `webSearchEnabled` (R14) |
| `skill` | `skill.ts` | `skill` | `always: [name]`, not `*` |
| `apply_patch` | `apply_patch.ts` | `edit` + `external_directory` | Only for `gpt-*` (non-`oss`, non-`gpt-4`) models |
| `execute` | `code-mode.ts` | per-MCP-tool key | Only `experimentalCodeMode`; dropped when no MCP tool is visible |
| `lsp` | `lsp.ts` | `lsp` | Only `experimentalLspTool` |
| `plan_exit` | `plan.ts` | — (Question service) | Only `experimentalPlanMode` + client `cli` |
| `discard_context` | `discard-context.ts` | — (no `ctx.ask` call) | Only when config `discard_context` is enabled (filter in `tools()`); not exempt from the doom-loop ask (R23) |

Session-level synthetic tools (`src/session/tools.ts`), not in the registry:
`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`
(added only when some connected MCP server advertises resources) and one tool
per connected MCP server tool (key = sanitized `server_tool` name). With
`experimentalCodeMode` the per-server MCP tools are replaced by `execute`.

Custom tools: files matching `{tool,tools}/*.{js,ts}` in any config directory
(`Glob.scanSync`, absolute, dot+symlink) and plugin-declared tools
(`plugin.tool` record). A file's `default` export is namespaced by the file
basename; other exports use `namespace_id` (registry `fromPlugin`).

Categories used elsewhere in the pipeline:
- edit-family (`edit`, `write`, `apply_patch`) share the `edit` permission key;
- read-family MCP resource tools map to the `read` permission key
  (`Permission.disabled` in `src/permission/index.ts`);
- everything else uses its own id as the permission key.

### T2 — Tool contract (`tool.ts`)

- R1. `Tool.define(id, init)` yields `Info { id, init() }`; `init()` acquires
  services, returns the body `{ description, parameters, jsonSchema?,
  execute, formatValidationError? }`. The returned effect carries
  `Truncate.Service | Agent.Service` in its environment.
- R2. `Tool.init(info)` compiles the body once per init: `execute` is wrapped
  so each call (a) decodes raw args with the body's Effect Schema decoder,
  (b) on decode failure fails with `Tool.InvalidArgumentsError` (detail via
  `formatValidationError` if provided, else `String(error)`), (c) runs the
  original `execute`, (d) if the result's `metadata.truncated === undefined`,
  applies `Truncate.output(result.output, {}, agent)` and stamps
  `metadata.truncated` (+ `outputPath` when truncated). The wrapper `orDie`s
  — `Def.execute` is typed infallible (`Effect<ExecuteResult>`); all
  failures travel as defects carrying the typed error class.
- R3. `InvalidArgumentsError.message` is the model-facing prose: "The {tool}
  tool was called with invalid arguments: {detail}.\nPlease rewrite the input
  so it satisfies the expected schema."
- R4. `Tool.Context` supplied per call by the session (T5): `sessionID`,
  `messageID` (assistant message), `agent` (name), `abort` (AbortSignal),
  `callID?`, `messages` (session history), `extra` (`model`,
  `bypassAgentCheck`, `promptOps`), `metadata()` (streaming title/metadata
  updates), `ask()` (permission gate).
- R5. `ExecuteResult` = `{ title, metadata, output, attachments? }`;
  attachments become session file parts (images re-normalized downstream).
- R6. Descriptions are static `.txt` imports per tool; `task` and `execute`
  compose extra sections at init/`tools()` time; `shell`'s description is
  rendered per shell kind and platform with the resolved truncation limits
  and default timeout (`shell/prompt.ts`).
- R7. `parameters` is an Effect Schema; `jsonSchema` (JSONSchema7) overrides
  the derived schema for providers (used by `task` to hide `background`
  behind a flag, and by plugin tools).

### T3 — Registry (`registry.ts`)

- R8. Registry state is per-instance (`InstanceState.make`): rebuilt when the
  instance context changes. Build scans custom tool files (waiting for config
  dependencies when matches exist), collects plugin tools, initializes all
  built-ins, and stores `{ custom, builtin, task, read }`.
- R9. Plugin/custom tools keep Zod-facing args; the registry bridges them:
  all-Zod args → `z.object` + `zodJsonSchema` + a declare-schema decoder;
  otherwise a legacy JSON Schema is built from entries (missing `args`
  normalizes to `{}` once, pre-1.14.49 compat, #27451/#27630). Their
  `execute` wraps the plugin call with an `EffectBridge`d `ask` (Promise-based
  for the plugin), adds `directory`/`worktree` to the context, and applies
  `Truncate.output` itself (custom defs bypass the `Tool.define` wrapper).
- R10. `tools(model)` filters the full list by model and flags: websearch by
  `webSearchEnabled`; `discard_context` by the `discard_context` config flag;
  `apply_patch` vs `edit`/`write` by the `gpt-*` heuristic
  (`modelID.includes("gpt-") && !oss && !gpt-4`); `execute` dropped unless a
  code-mode catalog description was produced. For each surviving tool the
  `tool.definition` plugin hook may mutate `description`, `parameters`, and
  `jsonSchema` (an unmodified `parameters` with a modified `jsonSchema`
  passes the override through). `task` gets a dynamically appended agent
  catalog (subagents whose `task` permission is not denied, sorted by name).
- R11. `named()` exposes the initialized `task` and `read` defs for internal
  reuse (subtask replay in `session/prompt.ts`).

### T4 — Output bounding (`truncate.ts`)

- R12. Limits: `tool_output.max_lines` / `tool_output.max_bytes` from config,
  defaulting to 2000 lines / 50 KiB. If `Config.Service` is absent from the
  environment, defaults apply.
- R13. Output within both limits passes through untruncated. Otherwise the
  full text is written to `TRUNCATION_DIR/tool_<ascending>` and replaced by a
  head (default) or tail preview plus `...N lines|bytes truncated...` and a
  hint. The hint names the Task tool (delegate to explore agent) when the
  agent's ruleset allows `task`, else names Grep/Read.
- R14. Retention: files older than 7 days under `TRUNCATION_DIR` are removed
  by an hourly cleanup fiber (first run after 1 minute); failures are logged,
  never fatal.
- R15. Tools that self-report `metadata.truncated` (shell, read via its own
  caps, MCP wrappers) skip the generic bounding in `Tool.init` (T2 R2).

### T5 — Session invocation path

- R16. `SessionTools.resolve` (`src/session/tools.ts`) builds the AI SDK tool
  record: for each registry tool, `inputSchema = ProviderTransform.schema(
  model, ToolJsonSchema.fromTool(def))`; `execute` runs via `EffectBridge`:
  build ctx → `tool.execute.before` plugin hook → `def.execute(args, ctx)` →
  assign attachment ids → `tool.execute.after` hook → (abort race) return.
- R17. `ctx.ask(req)` forwards to `Permission.Service.ask` with
  `sessionID`, `tool: {messageID, callID}`, and
  `ruleset: Permission.merge(agent.permission, session.permission ?? [])`,
  `orDie`d — permission typed errors surface as defects → failed tool call.
- R18. MCP server tools wrap `McpCatalog.convertTool` output: text parts
  joined; images/resources become attachments (unsupported MIME or >10 MiB
  blobs degrade to textual placeholders); output goes through
  `Truncate.output`. Each call asks permission with key = tool key,
  `patterns: ["*"]`, `always: ["*"]`.
- R19. MCP resource tools ask `read` with `mcp:<server>:*` (list) or
  `mcp:<server>:<uri>` (read, `always` = `mcp:<server>:*`) patterns.
- R20. `LLMRequestPrep.resolveTools` (`src/session/llm/request.ts`) removes a
  tool when `user.tools[name] === false` or `Permission.disabled` hides it
  (P10). `streamText` runs with `activeTools` excluding `invalid`.
- R21. Invalid provider args: `experimental_repairToolCall`
  (`src/session/llm.ts`) first retries a lowercased tool name if it exists;
  otherwise rewrites the call to `invalid` with `{tool, error}` input. The
  `invalid` tool returns the error text as a normal result so the model can
  rewrite the call.
- R22. The processor (`src/session/processor.ts`) projects tool-call events
  into durable tool parts; on tool error it records `state.error`. On
  `PermissionV1.RejectedError` or `Question.RejectedError` it sets
  `blocked = shouldBreak` where `shouldBreak = experimental.continue_loop_on_deny
  !== true` — by default the run stops after a rejection; with
  `continue_loop_on_deny` the model continues and sees the rejection text.
- R23. Doom-loop guard: when the last 3 parts are tool calls of the same tool
  with identical JSON input, the processor asks the `doom_loop` permission
  (pattern = tool name, ruleset = agent permission) before the third
  execution proceeds.
- R24. History replay (`src/session/message-v2.ts`): completed tool parts →
  `output-available` (text + media attachments per provider capability);
  error parts → `output-error` with `errorText` (interrupted metadata may
  substitute prior partial output); pending/running → `output-error`
  `"[Tool execution was interrupted]"` so every `tool_use` has a result.

### P1 — Permission model

- R25. A rule is `{ permission, pattern, action }` with
  `action ∈ {allow, deny, ask}`. Evaluation (`Permission.evaluate`) flattens
  all rulesets in order and picks the **last** rule whose `permission` and
  `pattern` both wildcard-match the request; no match defaults to
  `{action: "ask", pattern: "*"}`.
- R26. Wildcard matching (`packages/core/src/util/wildcard.ts`): `\` and `/`
  are unified; `*` → `.*`, `?` → `.`, everything else (including `.`)
  literal; a trailing `" *"` becomes `( .*)?` (so `"git *"` matches `"git"`);
  case-insensitive on win32.
- R27. Rule sources, lowest to highest precedence (order within the merged
  array; last match wins):
  1. agent defaults + per-agent base rules (`src/agent/agent.ts`):
     `defaults` = `"*": allow`, `doom_loop: ask`, `question: deny`,
     `plan_enter/plan_exit: deny`, `read: {"*": allow, "*.env": ask,
     "*.env.*": ask, "*.env.example": allow}`, `external_directory:
     {"*": ask, <whitelisted dirs>: allow}` (truncation dir, tmp, skill and
     reference dirs); then agent-specific additions (build: question+plan_enter
     allow; plan: question+plan_exit allow, `task.general` deny, plans dirs
     editable; general: todowrite deny; explore: everything denied except
     grep/glob/list/bash/webfetch/websearch/read + readonly external dirs;
     compaction/title/summary: all denied); then the user's global
     `permission` config; then per-agent `agent.<name>.permission` config.
  2. session rules (`session.permission`): set at session create, merge-patched
     via HTTP, or synthesized from the prompt's `tools` map
     (`{permission: t, pattern: "*", action: allow|deny}` per entry,
     persisted on the session).
  3. runtime approvals (`approved` in permission service state) — appended at
     ask time, hence highest precedence (see R34).
- R28. Config shape (`packages/core/src/v1/config/permission.ts`): a bare
  action string becomes `pattern: "*"`; an object maps pattern → action with
  `~`, `~​/…`, `$HOME…` expanded to the home directory (`expand` in
  `src/permission/index.ts`). Known keys are typed; unknown keys are
  accepted. User key order is preserved (`propertyOrder: "original"`) so
  permission precedence follows authoring order.
- R29. `Permission.merge(...)` is concatenation — precedence is purely
  positional (findLast), there is no specificity ranking.

### P2 — Ask/reply lifecycle (`permission/index.ts`)

- R30. `ask(input)`: for each request pattern, evaluate over
  `(ruleset, approved)`:
  - any `deny` → fail `PermissionV1.DeniedError` carrying the request's
    permission-matching rules (model sees: "The user has specified a rule
    which prevents you from using this specific tool call. Here are some of
    the relevant rules …");
  - all `allow` → proceed without prompting;
  - otherwise (≥1 `ask`) a request is needed.
- R31. A needed ask allocates `per_<ascending>` (or the supplied id), stores
  `{info, deferred}` in the per-instance pending map, publishes the
  `permission.asked` event, and awaits the deferred; leaving the await
  (either way) removes the pending entry.
- R32. `reply({requestID, reply, message?})`: unknown id →
  `PermissionV1.NotFoundError` (HTTP 404 `PermissionNotFoundError`).
  Otherwise the entry is removed and `permission.replied` is published with
  the session id and reply.
  - `reject`: the deferred fails with `CorrectedError(feedback)` when a
    message was supplied, else `RejectedError` (model sees "The user
    rejected permission to use this specific tool call." [+ feedback]);
    additionally every other pending ask **of the same session** is
    auto-rejected (each publishes `replied: "reject"` and fails
    `RejectedError`).
  - `once`: the deferred succeeds; nothing is remembered.
  - `always`: the deferred succeeds and one `allow` rule per pattern in the
    request's `always` list is appended to `approved`; then other pending
    asks of the same session whose every pattern now evaluates `allow` under
    `approved` are auto-resolved (publishing `replied: "always"`).
- R33. Instance shutdown: the state finalizer fails every still-pending
  deferred with `RejectedError` and clears the map.
- R34. Runtime precedence edge: `approved` rules are evaluated after the
  configured ruleset, so a prior `always` approval keeps winning over a
  later-added config `ask` (and even `deny`) rule for the same
  permission+pattern until the process restarts.
- R35. Persistence: `approved` and `pending` live in per-instance in-memory
  state only. Nothing is written to disk in V1 (the `PermissionSaved` store
  under `packages/core` belongs to the V2 permission service). "always"
  approvals do not survive restarts.

### P3 — Surfaces and UI interaction

- R36. Events (via `EventV2Bridge`): `permission.asked` (full request) and
  `permission.replied` (sessionID, requestID, reply). Clients (TUI, desktop)
  subscribe and render prompts; the session's tool fiber parks on the
  deferred until a reply lands.
- R37. HTTP: instance routes `/permission` group — list pending, reply by
  request id; session group — `permissionRespond` responds per
  session+request (both funnel into `Permission.Service.reply`). GitLab
  workflow models ask the synthetic `workflow_tool_approval` permission with
  tool-name patterns through the same service (`src/session/llm.ts`).

### P4 — Tool permission matrix

What each tool asks (all via `ctx.ask`; `always` is what a UI "always allow"
persists as a runtime rule):

| Tool | permission key | patterns | always |
|---|---|---|---|
| read | `read` | worktree-relative path | `*` |
| read/edit/write/apply_patch/glob/grep/lsp (outside worktree) | `external_directory` | `<dir>/*` | `<dir>/*` |
| edit, write, apply_patch | `edit` | worktree-relative path(s) | `*` |
| glob | `glob` | glob pattern | `*` |
| grep | `grep` | regex pattern | `*` |
| bash | `external_directory` (first, if scanned dirs outside worktree) | `<dir>/*` | `<dir>/*` |
| bash | `bash` | full command text (redirect-aware) | `<arity prefix> *` |
| task | `task` | subagent type | `*` |
| webfetch | `webfetch` | url | `*` |
| websearch | `websearch` | query | `*` |
| skill | `skill` | skill name | skill name |
| todowrite | `todowrite` | `*` | `*` |
| lsp | `lsp` | `*` | `*` |
| MCP tool | tool key | `*` | `*` |
| MCP resource list/read | `read` | `mcp:<server>:*` / `mcp:<server>:<uri>` | `mcp:<server>:*` |
| (processor) doom loop | `doom_loop` | tool name | tool name |
| (workflow models) | `workflow_tool_approval` | `name` or `name: title` | same |
| question / plan_exit | — | Question service instead | — |
| discard_context | — | no permission ask (config-gated in `tools()`) | — |
| execute (code mode) | per-MCP-tool key | `*` | `*` |

Shell specifics (`shell.ts`): commands are parsed with tree-sitter (bash or
PowerShell grammar); file-touching commands (an explicit allowlist: cd/rm/cp/
mv/mkdir/touch/cat/… plus PowerShell cmdlets and cmd.exe builtins) contribute
resolved absolute paths; args are unquoted, `~`/env-expanded (PowerShell),
provider-qualified, cygpath-resolved (Windows POSIX shells), and dynamic
(`$(…)`, `${…`, backticks, globs) prefixes are skipped. Paths outside the
instance trigger the `external_directory` ask. Every non-cd command
contributes its full source text as a `bash` pattern; the `always` pattern is
`<BashArity prefix> *` (longest known command prefix, e.g. `git checkout *`).
A `workdir` outside the instance always adds the `external_directory` ask.

### Per-tool behavior highlights

- `read`: resolves relative to the instance directory; directory listings
  (sorted, `/` suffix, symlink-aware) with offset/limit; images/PDFs become
  attachments; binary detection by extension or >30% non-printables in a
  4 KiB sample fails; line reads cap at 2000 lines / 50 KiB / 2000 chars per
  line with continuation hints; "did you mean" suggestions on miss; LSP
  warm-up forked best-effort; instruction files (`Instruction.resolve`)
  append a `<system-reminder>` block.
- `edit`: per-file semaphore; `oldString === newString` and empty-oldString
  on existing files are errors; nine replacers tried in order (exact,
  line-trimmed, block-anchor with 0.65 Levenshtein similarity, whitespace-,
  indentation-, escape-normalized, trimmed-boundary, context-aware,
  multi-occurrence); disproportionate matches refused; unique-match required
  unless `replaceAll`; CRLF/BOM preserved; optional formatter; publishes
  `file.edited` + watcher events; LSP diagnostics appended.
- `write`: full-file replacement under the `edit` permission; preserves
  source BOM; formatter; diagnostics for the file and up to 5 other files.
- `apply_patch`: parses `*** Begin Patch` hunks (add/update/delete/move),
  pre-computes per-file diffs, one `edit` ask with all relative paths, then
  applies; move = write-new + remove-old; publishes per-file events;
  LSP diagnostics per touched file.
- `task`: enforces `subagent_depth` (default 1) by walking parent sessions;
  asks `task` unless `bypassAgentCheck`; derives the child session ruleset
  (`deriveSubagentSessionPermission`: parent's `external_directory` + deny
  rules, plus default `todowrite`/`task` denies unless the subagent grants
  them, plus `experimental.primary_tools` denies); foreground waits on a
  background job (abort cancels), background mode (experimental flag)
  returns immediately and injects a synthetic result prompt on completion.
- `webfetch`: http(s) only; format-negotiated Accept header; Cloudflare
  challenge 403 retried with honest UA; 30 s default / 120 s max timeout;
  5 MiB cap; html→markdown/text via turndown/htmlparser2; images attach.
- `websearch`: provider = `OPENCODE_WEBSEARCH_PROVIDER` env, else flags
  (`enableParallel`/`enableExa`), else stable session-id checksum split;
  calls the Exa or Parallel MCP-style HTTP endpoints (25 s timeout).
- `skill`: requires the skill (404 → defect), asks `skill` per name, emits
  the SKILL.md content plus a sampled (≤10) file list.
- `bash` execution: default timeout 120 s (`flags.bashDefaultTimeoutMs`);
  spawned detached (non-Windows) with `stdin: ignore`; output streams into a
  ring buffer of 2× maxBytes with a 30 000-char tail preview in metadata,
  spooling to a truncation file past the cap; final output tail-bounded;
  timeout/abort append `<shell_metadata>` notes and kill the process;
  `shell.env` plugin hook merges env.

## Invariants

- I1. No built-in tool performs a privileged side effect before its `ask`
  resolves; deny/reject aborts the call before the effect.
- I2. A tool's model-facing failure text is the typed error's `message`
  (`InvalidArgumentsError`, `PermissionV1.*Error`) — the processor records it
  as the tool part error and replay feeds it back as `errorText`.
- I3. Bounding is idempotent per result: a tool that self-reports
  `metadata.truncated` is not re-bounded by the wrapper.
- I4. Rule precedence is strictly array order + findLast; later sources
  (session over agent, approved over everything) win.
- I5. Pending asks are per instance; reject cascades only within one
  session; shutdown rejects everything pending.
- I6. `edit`/`write`/`apply_patch` share one permission namespace; hiding any
  of them requires a `pattern: "*"` deny on `edit` (P10).

## Errors and undefined behavior

- E1. `Def.execute` is infallible in the type; every failure is a defect.
  Callers must catch causes (processor does; CLI debug paths may not).
- E2. `Permission.ask` deny-checks patterns in order and fails on the first
  deny even if other patterns would allow.
- E3. `always` approvals override later config changes until restart (R34) —
  surprising but current behavior.
- E4. `expand()` in `fromConfig` only expands `~`- and `$HOME`-prefixed
  patterns; other variables are not expanded.
- E5. Shell scanning is heuristic: allowlisted command names, static
  arguments only; dynamically constructed or unknown commands degrade to the
  full-command-text pattern; PowerShell aliases are deliberately not
  normalized (double-prompt risk accepted).
- E6. `Wildcard.match` compiles a fresh RegExp per call (no cache); a
  pattern with regex metacharacters is escaped, so matching is literal
  except `*`/`?`.
- E7. If a custom tool file exports a non-plugin shape it is silently
  ignored (`isPluginTool` requires `args`+`description`+`execute`).
- E8. `InvalidArgumentsError` competes with the AI SDK's own schema check:
  args that fail the advertised JSON Schema are repaired to the `invalid`
  tool (R21) and never reach `Def.execute`; `InvalidArgumentsError` covers
  the Effect-Schema-only gap between the two schemas.

## Known limitations and stubs

- L1. V1 runtime approvals are not persisted (P4 R35); the V2
  `PermissionSaved` store exists but is not consulted by the V1 service.
- L2. `Tool.DynamicDescription` in `tool.ts` is dead (unused, marked
  "TODO: remove this hack").
- L3. No tool currently defines `formatValidationError`; decode details use
  `String(error)`.
- L4. `plan-enter.txt` and the `plan_enter` permission key exist (agent
  defaults, `cli/cmd/run.ts` gating) but there is no plan-enter tool in
  `src/tool`; the `list` permission key allowed for the explore agent has no
  corresponding tool (the `ls` tool does not exist on this branch).
- L5. `Permission.disabled` matches rules on the permission key only and then
  requires the found rule's `pattern === "*"` — a specific-pattern deny never
  hides a tool, and a later `pattern: "*"` `ask`/`allow` rule neutralizes an
  earlier blanket deny (findLast).
- L6. The shell tool id remains `"bash"` for compatibility; renaming is
  deferred to 2.0 (`shell/id.ts`).
- L7. `grep`'s `truncated` flag double-counts the limit sentinel
  (`rows.length === limit` is also true when exactly `limit` matches exist).

## Configuration

| Name | Allowed / range | Default | Effect |
|---|---|---|---|
| `permission` (config) | action string or `{pattern: action}` per key | — | Rules appended after agent defaults (R27–R28) |
| `agent.<name>.permission` | same | — | Per-agent override, merged last of the static sources |
| `tool_output.max_lines` | positive int | 2000 | Truncation line limit (R12) |
| `tool_output.max_bytes` | positive int | 51200 | Truncation byte limit (R12) |
| `subagent_depth` | positive int | 1 | Max task-tool nesting |
| `shell` (config) | shell name | acceptable shell | Shell kind for the bash tool |
| `experimental.continue_loop_on_deny` | bool | false | Keep the provider loop running after a permission rejection |
| `flags.bashDefaultTimeoutMs` | ms | 120000 | Default bash timeout |
| `OPENCODE_WEBSEARCH_PROVIDER` | `exa` \| `parallel` | — | Overrides websearch provider selection |
| `EXA_API_KEY` / `PARALLEL_API_KEY` | string | — | Websearch endpoint auth |
