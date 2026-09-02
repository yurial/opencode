# Specification Index

| Path | Reference | Status | Summary |
|---|---|---|---|
| specs/config-parameters.md | config-v1 | stable | V1 configurable parameters: keys, values, channels, merge precedence |
| specs/project.md | project-api | stable | Legacy per-project HTTP API sketch |
| specs/tui-package.md | tui-package | draft | TUI extraction into @opencode-ai/tui package |
| specs/tui-session-display.md | tui-session-display | draft | Session screen: thinking mode, reasoning timer, persisted context-excluded meta parts |
| specs/v2/config-parameters.md | config-v2 | draft | V2 configurable parameters: keys, values, implementation status |
| specs/v2/config.md | config-v2-review | draft | V2 config review ledger: keep/remove/redesign per legacy group |
| specs/v2/provider-model.md | config-v2-provider-model | draft | V2 provider/model catalog schemas and runner adaptation |
| specs/v2/provider-policy.md | config-v2-policy | draft | Policy statement shape, wildcard matching, ordering |
| specs/v2/catalog-config-plugin-lifecycle.md | config-v2-catalog-lifecycle | draft | Catalog/config/plugin reload lifecycle options |
| specs/v2/instructions.md | core-v2-instructions | draft | packages/core v2 porting directions: services, hooks, boundaries |
| specs/v2/session.md | config-v2-session | draft | V2 session API, context epochs, compaction, runtime parity table |
| specs/v2/tools.md | v2-tools | draft | V2 local tool type, registration, execution, output bounding |
| specs/v2/schema-changelog.md | v2-schema-changelog | draft | V2 database/event/HTTP/SDK schema change ledger |
| specs/v2/todo.md | v2-todo | draft | V2 follow-up worklist |
| specs/v2/api.html | — | artifact | Rendered HTML API map (generated artifact, no reference ID) |
| specs/storage/effect-sqlite-package.md | storage-effect-sqlite | draft | Vendored Drizzle effect-sqlite package scope |
| specs/storage/remove-opencode-db.md | storage-remove-db | draft | Removal of legacy opencode storage/db.ts wrapper |
| packages/opencode/specs/tui-plugins.md | tui-plugins | stable | TUI plugin system: tui.json keys, loading, dedupe |
| packages/opencode/specs/openapi-translation-cleanup.md | openapi-cleanup | draft | Trimming OpenAPI translation layer |
| packages/opencode/specs/effect/guide.md | effect-guide | stable | Effect coding style guide for packages/opencode |
| packages/opencode/specs/effect/migration.md | effect-migration | stable | Effect migration patterns |
| packages/opencode/specs/effect/errors.md | effect-errors | draft | Typed error conventions |
| packages/opencode/specs/effect/facades.md | effect-facades | draft | Runtime facade boundaries |
| packages/opencode/specs/effect/instance-context.md | effect-instance-context | stable | Per-directory InstanceState conventions |
| packages/opencode/specs/effect/routes.md | effect-routes | draft | HttpApi route conventions |
| packages/opencode/specs/effect/schema.md | effect-schema | draft | Schema conventions |
| packages/opencode/specs/effect/server-package.md | effect-server-package | draft | Server package extraction |
| packages/opencode/specs/effect/tools.md | effect-tools | draft | Tool registration conventions |
| packages/opencode/specs/effect/todo.md | effect-todo | draft | Effect migration roadmap |
| packages/opencode/specs/effect/loose-ends.md | effect-loose-ends | draft | Effect migration leftovers |
| packages/opencode/specs/effect/error-boundaries-plan.md | effect-error-boundaries | draft | Error boundary rollout plan |
| packages/opencode/specs/v2/message-shape.md | opencode-v2-message-shape | draft | V2 message/part wire shape |
| packages/opencode/specs/v2/notifications.md | opencode-v2-notifications | draft | V2 notification notes |
| packages/opencode/specs/v2/tui-command-shim.md | opencode-v2-tui-shim | draft | TUI command shim for v2 |
| packages/opencode/specs/v2/api.ts | — | artifact | Example snippet (not a spec; kept adjacent to its documents) |

Status legend: `stable` — implemented, binding; code/spec divergence is a
finding. `draft` — being designed; deviations are not yet bugs. `artifact` —
generated or example content that documents a concrete output, not a
normative spec; no reference ID is allocated and no other spec may cite it.

Notes:
- `specs/v2/api.html` is a committed render of the V2 API map (added in
  commit d43124abe0 "ignore: notes"). Kept as an artifact row; it is not
  indexed as a normative spec and no reference ID is assigned. Regeneration/
  removal can be decided separately.
- `packages/opencode/specs/v2/api.ts` is a usage example imported by docs, not
  a specification.
