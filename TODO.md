# TODO

## discard-context UI (issue-discard-context)

- **session-ui (web)**: маркер-дивидер показывает «Discarded N context parts» сразу, включая
  статусы pending/running (count берётся из input). Отдельного pending-состояния нет —
  так же ведёт себя и маркер compaction.
- **session-ui**: маркер не покрыт unit-тестами — bun test не может импортировать
  `message-part.tsx` (транзитивный Vite-импорт `markdown.worker.ts?worker&url`);
  в пакете тестируются только чистые `.ts` модули.
- **i18n**: parity-тест `packages/app/src/i18n/parity.test.ts` требует наличия каждого ключа
  `packages/ui/src/i18n/en.ts` во всех 61 локалях, поэтому ключи
  `ui.messagePart.context.discarded` и `ui.tool.discardContext` добавлены во все локали.
  Для 28 локалей без перевода (am, az, bn, br, dv, dz, et, fo, hy, is, ka, km, lo, lt, lv,
  mk, mn, ms, my, ne, pa, si, sl, sq, tg, tk, ur, uz) вставлена английская копия — нужен
  перевод отдельным translation-пассом.
- **TUI**: маркер `discard_context` остаётся видимым при выключенных деталях
  (`showDetails = false`) — намеренно: это маркер уровня контекста, как compaction,
  а не деталь тула.
- **TUI transcript**: экспорт содержит одну строку `**Discarded N context parts**`
  (N = ids.length); сами ids в экспорт не попадают.
- packages/core (сам tool `discard_context`) реализуется параллельной задачей и здесь
  не трогался; UI-часть опирается только на имя тула и форму входа `{ ids: string[] }`.

## PrimeTime (packages/core/src/v1/config/provider.ts — `primeTimeActive`)

- **SQL-миграция для console ModelTable не сгенерирована.** Колонки prime_time_* добавлены в
  TS-схему (`packages/console/core/src/schema/model.sql.ts`), миграция генерируется отдельным
  процессом (`chore: generate`).

## Не связано с PrimeTime (предсуществующее на main)

- `packages/schema/test/event-manifest.test.ts`: 2 падения на чистом main
  (порядок/идентификаторы манифеста событий). Воспроизведено без изменений PrimeTime.
- `packages/core/test/tool-webfetch.test.ts` ("WebFetchTool registration > returns an error
  result when HTML-to-Markdown conversion throws"): флакирует при полной нагрузке прогона
  (в т.ч. с --coverage), воспроизводится на чистом main; изолированный запуск проходит.
- `packages/opencode/test/provider/header-timeout.test.ts` ("chunkTimeout raises a response
  stream error when SSE body stalls"): падает и на чистом main, и с изменениями PrimeTime
  (SSE read timed out); не зависит от ветки.

## issue-app-build-resolve findings

- **Legacy SDK gen drift (content, not churn).** Committed
  `packages/sdk/js/src/v2/gen/types.gen.ts` is stale vs the current Protocol: a full
  `bun run build` in `packages/sdk/js` yields a deterministic +20/−1 diff adding the
  prime-time model fields (`primeTimeStart`/`primeTimeEnd`/`primeTimeDay` on
  `ProviderConfig.options`, `Model`, `ModelV2Info`) and `retries?: number` on
  `ProviderConfig.options`. Everything else in the ~16k/−19k "churn" observed mid-run is
  hey-api native formatting that the script's final prettier step normalizes away. Needs a
  separate `chore(sdk): regenerate legacy JS SDK` commit (deliberately not included in the
  build fix).

- ретраить ошибку "Rate limit reached for requests" и "The service may be temporarily overloaded, please try again later" в том числе в субагенте
- при смене модели нужно перечитывать ее лимит контекста и менять триггер, когда должен вызываться compaction.

## Config-parameters spec (issue-config-params) findings

Code/spec gaps discovered while documenting the configuration surface. No code
was changed (docs-only task).

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

## PrimeTime (packages/core/src/v1/config/provider.ts — `primeTimeActive`)

- **Таймзона не определена.** Проверка использует локальное время процесса. Нужно решение:
  UTC, локальная таймзона сервера или таймзона workspace.
- **Малформированные значения отключают prime-time.** `primeTimeStart`/`primeTimeEnd` — произвольные
  строки (`Schema.String`); формат без секунд или с мусором даёт NaN в seconds-of-day → сравнения
  false → ограничение молча не действует (fail-open, зафиксирован в контракте `primeTimeActive`).
  Решение: валидация формата в схеме или fail-closed.
- **SQL-миграция для console ModelTable не сгенерирована.** Колонки prime_time_* добавлены в
  TS-схему (`packages/console/core/src/schema/model.sql.ts`), миграция генерируется отдельным
  процессом (`chore: generate`).

## Не связано с PrimeTime (предсуществующее на main)

- `packages/schema/test/event-manifest.test.ts`: 2 падения на чистом main
  (порядок/идентификаторы манифеста событий). Воспроизведено без изменений PrimeTime.
- `packages/core/test/tool-webfetch.test.ts` ("WebFetchTool registration > returns an error
  result when HTML-to-Markdown conversion throws"): флакает при полной нагрузке прогона
  (в т.ч. с --coverage), воспроизводится на чистом main; изолированный запуск проходит.
- `packages/opencode/test/provider/header-timeout.test.ts` ("chunkTimeout raises a response
  stream error when SSE body stalls"): падает и на чистом main, и с изменениями PrimeTime
  (SSE read timed out); не зависит от ветки.

- ретраить ошибку "Rate limit reached for requests" и "The service may be temporarily overloaded, please try again later" в том числе в субагенте
- при смене модели нужно перечитывать ее лимит контекста и менять триггер, когда должен вызываться compaction.

## issue-event-prune follow-ups (event-retention, revue 2c0b9ed8e1)

- R6: нет теста на сбой prune (нужен fault injection) — проверить, что запрос sync не падает.
- R5: нет end-to-end теста на unlisted aggregate с частичным выжившим хвостом (пример из спеки: запрос {s1:7} получает s2 c seq>=5).
- Производительность: DELETE на каждый /sync/history по всему floor map — большинство после первой чистки нулевые; рассмотреть кэш "уже вычищено до seq".
