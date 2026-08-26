# TODO

Config-parameters spec (issue-config-params) findings — code/spec gaps
discovered while documenting the configuration surface. No code was changed
(docs-only task).

1. **V2 `default_agent` diverges from review decision.**
   specs/v2/config.md (Group 8) marks `default_agent` as `remove`, but the
   implemented V2 schema (`packages/core/src/config.ts:39`) and the migrator
   (`packages/core/src/v1/config/migrate.ts:40`) keep it, and the config-agent
   plugin consumes it (`packages/core/src/config/plugin/agent.ts`). Either the
   ledger or the schema must change.

2. **V2 `commands` diverges from review decision.**
   specs/v2/config.md (Group 3) marks `command` as `remove` ("named reusable
   user workflows belong to skills"), but the implemented V2 schema defines
   `commands` (`packages/core/src/config.ts:93`), the migrator ports V1
   `command` into it (`packages/core/src/v1/config/migrate.ts:63`), and a
   config-command plugin loads both documents and Markdown commands
   (`packages/core/src/config/plugin/command.ts`).

3. **V1 `subagent_depth` is silently dropped by the V1→V2 migration.**
   The key exists in the V1 schema (`packages/core/src/v1/config/config.ts:84`)
   but appears neither in the review ledger groups nor in
   `ConfigMigrateV1.migrate`, so its value is lost without an explicit
   decision.

4. **V1 `compaction.tail_turns` is silently dropped by the V1→V2 migration.**
   Same situation as (3): present in V1
   (`packages/core/src/v1/config/config.ts:157`), absent from the ledger and
   from the migrator.

5. **V1 `logLevel` is a dead config key.**
   The schema accepts it (`packages/core/src/v1/config/config.ts:37`) but no
   code reads it; the effective level comes from the `OPENCODE_LOG_LEVEL` env
   var / `--log-level` CLI flag (see `packages/core/src/observability/logging.ts:57`).
   specs/v2/config.md already decides `remove` for V2.

6. **`enabled_providers`/`disabled_providers` are not migrated to policies.**
   specs/v2/provider-policy.md specifies equivalent `provider.use` policy
   statements, and `ConfigMigrateV1.isV1` treats the keys as V1 markers, but
   `migrate()` drops them — a migrated config silently loses provider
   allow/deny restrictions.

7. **Unvalidated ranges in the V1 schema.**
   `temperature`/`top_p` (agent), `provider.options.*` passthrough values,
   `oauth.redirectUri`, MCP/LSP/formatter URLs and commands are accepted
   without range or format validation and fail only at use time. Documented
   as "unvalidated" in specs/config-parameters.md; no code change requested.

8. **`OPENCODE_LOG_LEVEL` accepts only exact uppercase values.**
   `minimumLogLevel()` compares `value.toUpperCase()` against the level map —
   this is fine — but the CLI `--log-level` choices are uppercase while env
   values in other case variants also work; the config-v1 spec documents env
   values as uppercase-only per the map keys (minor inconsistency risk, no
   action taken).

9. **Subagents (task tool) intermittently return empty results.**
   Subagent runs periodically complete with no final message ("stall"):
   observed 2026-08-26 in this environment — 7 flash-agent launches returned
   empty; resuming the same session via task_id worked. Symptom: task
   state=completed with an empty task_result. Deferred by the user until the
   current task is finished; root cause not yet investigated.
