# Specification Index

- **Path**: specs/app-desktop-cli.md
  **Reference**: app-desktop-cli
  **Status**: draft
  **Summary**: Web/desktop app, Electron wrapper, shared ui package, and the new lildax CLI: entry points, v1/v2 server compatibility, sidecar/daemon hosting, packaging
- **Path**: specs/config-agents.md
  **Reference**: config-agents
  **Status**: stable
  **Summary**: V1 config/agent/skill/command runtime: discovery-and-merge pipeline, agent schema and resolution, skill and command discovery, hot-reload (instance disposal) semantics
- **Path**: specs/config-parameters.md
  **Reference**: config-v1
  **Status**: stable
  **Summary**: V1 configurable parameters: keys, values, channels, merge precedence
- **Path**: specs/core-session.md
  **Reference**: core-session
  **Status**: draft
  **Summary**: As-built V2 session and prompt lifecycle: durable admission and delivery modes, serialized execution and the provider-turn runner, context epochs, compaction, revert, V1 boundary
- **Path**: specs/core-tools-permissions.md
  **Reference**: core-tools-permissions
  **Status**: draft
  **Summary**: V1 tool system and permission flow: tool contract, registry, invocation, ask/reply rules
- **Path**: specs/discard-context.md
  **Reference**: core-discard-context
  **Status**: stable
  **Summary**: discard_context flag and tool across the V2 and V1 runtimes: assistant and user marked-part history filtering before lowering and compaction, flag-gated projection-only part-id markers, non-empty settled-output line, session-ui/TUI/transcript markers and the TUI sidebar statistics block, TUI discarded-block transcript styling, token attribution exact for fully discarded messages and deterministic char-weighted for partially discarded ones
- **Path**: specs/event-retention.md
  **Reference**: event-retention
  **Status**: draft
  **Summary**: Sync-mode retention: pruning durable event rows below the in-memory watermark floor
- **Path**: specs/integrations.md
  **Reference**: integrations
  **Status**: draft
  **Summary**: V1 integrations: LSP/MCP hosts, formatters, IDE detection, sharing, git/snapshot/worktree, plugin host, ACP adapter, experimental control-plane workspaces
- **Path**: specs/provider-models.md
  **Reference**: provider-models
  **Status**: stable
  **Summary**: Provider/LLM layer behavior: model catalog sources, variants, auth, streaming contract, retries, V2 catalog
- **Path**: specs/project.md
  **Reference**: project-api
  **Status**: stable
  **Summary**: Legacy per-project HTTP API sketch
- **Path**: specs/scheduler-view.md
  **Reference**: scheduler-view
  **Status**: draft
  **Summary**: Schedule visibility layer: tool-output ETA annotations, read-only session schedule-list endpoint, TUI sidebar schedules block
- **Path**: specs/scheduler.md
  **Reference**: scheduler
  **Status**: stable
  **Summary**: AI-facing scheduler tool: session-bound schedules (interval, cron, one-shot), fire delivery into V2 and V1 sessions, catch-up semantics, persistence, permission gating
- **Path**: specs/server-api-sdk.md
  **Reference**: server-api-sdk
  **Status**: draft
  **Summary**: Protocol/Server/Client/SDK stack as built: HttpApi groups and middleware, V2 handlers and transports (SSE/WebSocket), hosting entrypoints, client and legacy SDK generation
- **Path**: specs/storage-events.md
  **Reference**: storage-events
  **Status**: stable
  **Summary**: SQLite storage and events: database and migration runtime, JSON file storage, EventV2 durable log (projectors, replay, ownership), bridge/SSE delivery, experimental workspace sync
- **Path**: specs/tool-interactive.md
  **Reference**: tool-interactive
  **Status**: draft
  **Summary**: V2 interactive process tool family (start/write/wait/cancel): auto-fed interactive jobs, exchange/job/lifetime budgets, output spool and chunk bounding, permission gating, crash recovery
- **Path**: specs/tui-architecture.md
  **Reference**: tui-architecture
  **Status**: stable
  **Summary**: TUI architecture and runtime: launch hosts and worker model, provider tree, routes/keymap/commands, legacy Sync and V2 Data stores, prompt/permission/question flows, client lifecycle logging
- **Path**: specs/tui-package.md
  **Reference**: tui-package
  **Status**: draft
  **Summary**: TUI extraction into @opencode-ai/tui package
- **Path**: specs/tui-session-display.md
  **Reference**: tui-session-display
  **Status**: draft
  **Summary**: Session screen: thinking mode, reasoning timer, persisted context-excluded meta parts
- **Path**: specs/tui-tab-rename.md
  **Reference**: tui-tab-rename
  **Status**: stable
  **Summary**: tmux tab rename: tab_rename tui parameter (default true), ESC k emission gated on TMUX, sanitizer, engine-agnostic sync-store trigger
- **Path**: specs/tui-theme.md
  **Reference**: tui-theme
  **Status**: stable
  **Summary**: TUI theme v2: per-element format, element catalog with defaults, v1 migration, resolution and errors, TUI/run-CLI/plugin consumption
- **Path**: specs/v2/config-parameters.md
  **Reference**: config-v2
  **Status**: draft
  **Summary**: V2 configurable parameters: keys, values, implementation status
- **Path**: specs/v2/config.md
  **Reference**: config-v2-review
  **Status**: draft
  **Summary**: V2 config review ledger: keep/remove/redesign per legacy group
- **Path**: specs/v2/provider-model.md
  **Reference**: config-v2-provider-model
  **Status**: draft
  **Summary**: V2 provider/model catalog schemas and runner adaptation
- **Path**: specs/v2/provider-policy.md
  **Reference**: config-v2-policy
  **Status**: draft
  **Summary**: Policy statement shape, wildcard matching, ordering
- **Path**: specs/v2/catalog-config-plugin-lifecycle.md
  **Reference**: config-v2-catalog-lifecycle
  **Status**: draft
  **Summary**: Catalog/config/plugin reload lifecycle options
- **Path**: specs/v2/instructions.md
  **Reference**: core-v2-instructions
  **Status**: draft
  **Summary**: packages/core v2 porting directions: services, hooks, boundaries
- **Path**: specs/v2/session.md
  **Reference**: config-v2-session
  **Status**: draft
  **Summary**: V2 session API, context epochs, compaction, runtime parity table
- **Path**: specs/v2/tools.md
  **Reference**: v2-tools
  **Status**: draft
  **Summary**: V2 local tool type, registration, execution, output bounding
- **Path**: specs/v2/schema-changelog.md
  **Reference**: v2-schema-changelog
  **Status**: draft
  **Summary**: V2 database/event/HTTP/SDK schema change ledger
- **Path**: specs/v2/todo.md
  **Reference**: v2-todo
  **Status**: draft
  **Summary**: V2 follow-up worklist
- **Path**: specs/storage/effect-sqlite-package.md
  **Reference**: storage-effect-sqlite
  **Status**: draft
  **Summary**: Vendored Drizzle effect-sqlite package scope
- **Path**: specs/storage/remove-opencode-db.md
  **Reference**: storage-remove-db
  **Status**: draft
  **Summary**: Removal of legacy opencode storage/db.ts wrapper
- **Path**: packages/opencode/specs/tui-plugins.md
  **Reference**: tui-plugins
  **Status**: stable
  **Summary**: TUI plugin system: tui.json keys, loading, dedupe
- **Path**: packages/opencode/specs/openapi-translation-cleanup.md
  **Reference**: openapi-cleanup
  **Status**: draft
  **Summary**: Trimming OpenAPI translation layer
- **Path**: packages/opencode/specs/effect/guide.md
  **Reference**: effect-guide
  **Status**: stable
  **Summary**: Effect coding style guide for packages/opencode
- **Path**: packages/opencode/specs/effect/migration.md
  **Reference**: effect-migration
  **Status**: stable
  **Summary**: Effect migration patterns
- **Path**: packages/opencode/specs/effect/errors.md
  **Reference**: effect-errors
  **Status**: draft
  **Summary**: Typed error conventions
- **Path**: packages/opencode/specs/effect/facades.md
  **Reference**: effect-facades
  **Status**: draft
  **Summary**: Runtime facade boundaries
- **Path**: packages/opencode/specs/effect/instance-context.md
  **Reference**: effect-instance-context
  **Status**: stable
  **Summary**: Per-directory InstanceState conventions
- **Path**: packages/opencode/specs/effect/routes.md
  **Reference**: effect-routes
  **Status**: draft
  **Summary**: HttpApi route conventions
- **Path**: packages/opencode/specs/effect/schema.md
  **Reference**: effect-schema
  **Status**: draft
  **Summary**: Schema conventions
- **Path**: packages/opencode/specs/effect/server-package.md
  **Reference**: effect-server-package
  **Status**: draft
  **Summary**: Server package extraction
- **Path**: packages/opencode/specs/effect/tools.md
  **Reference**: effect-tools
  **Status**: draft
  **Summary**: Tool registration conventions
- **Path**: packages/opencode/specs/effect/todo.md
  **Reference**: effect-todo
  **Status**: draft
  **Summary**: Effect migration roadmap
- **Path**: packages/opencode/specs/effect/loose-ends.md
  **Reference**: effect-loose-ends
  **Status**: draft
  **Summary**: Effect migration leftovers
- **Path**: packages/opencode/specs/effect/error-boundaries-plan.md
  **Reference**: effect-error-boundaries
  **Status**: draft
  **Summary**: Error boundary rollout plan
- **Path**: packages/opencode/specs/v2/message-shape.md
  **Reference**: opencode-v2-message-shape
  **Status**: draft
  **Summary**: V2 message/part wire shape
- **Path**: packages/opencode/specs/v2/notifications.md
  **Reference**: opencode-v2-notifications
  **Status**: draft
  **Summary**: V2 notification notes
- **Path**: packages/opencode/specs/v2/tui-command-shim.md
  **Reference**: opencode-v2-tui-shim
  **Status**: draft
  **Summary**: TUI command shim for v2

Status legend: `stable` — implemented, binding; code/spec divergence is a
finding. `draft` — being designed; deviations are not yet bugs. `artifact` —
generated or example content that documents a concrete output, not a
normative spec; no reference ID is allocated and no other spec may cite it.

Notes:
  - `specs/v2/api.html` is a committed render of the V2 API map (added in
    commit d43124abe0 "ignore: notes"). It is a generated artifact, not a
    normative spec: it carries no table row, no reference ID is allocated, and
    no other spec may cite it. Regeneration/removal can be decided separately.
  - `packages/opencode/specs/v2/api.ts` is a usage example imported by docs,
    not a specification; it carries no table row and no reference ID.
