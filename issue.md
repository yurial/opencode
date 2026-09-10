# issue: спеки на текущий код opencode

Цель: подготовить спецификации, описывающие текущее поведение кода, чтобы упростить
будущие изменения. Работа в worktree `~/wt/opencode/issue-codebase-specs`, ветка `issue-codebase-specs`.

## Правила для всех спек-агентов
- Писать behavior-spec: что делает система, контракты, инварианты, потоки данных, границы; не «как портировать».
- Перед началом читать `specs/index.md` и релевантные существующие спеки: не дублировать, ставить ссылки; при расхождении кода и stable-спеки — фиксировать в спеке и в `specs/DEVIATIONS.md`? (нет — DEVIATIONS.md не трогать, отмечать в отчёте).
- Не редактировать `specs/index.md` (обновит финальный агент).
- Стиль — как у существующих спек в `specs/`: markdown, разделы, нормальный тон.

## Задачи
- [ ] specs/core-session.md — session/prompt lifecycle, V2 admission/execution (src/session)
- [ ] specs/core-tools-permissions.md — tool registry, permission flow (src/tool, src/permission)
- [ ] specs/provider-models.md — provider catalog, models/variants, auth (src/provider, packages/llm)
- [ ] specs/config-agents.md — config loading, agents, hot reload (src/config, src/agent)
- [ ] specs/server-api-sdk.md — server HttpApi, protocol, client/sdk generation
- [ ] specs/storage-events.md — storage, sqlite, events, sync
- [ ] specs/tui-architecture.md — packages/tui: screens, state, commands, keybinds
- [ ] specs/integrations.md — LSP, MCP, formatter, IDE, share, git/worktree/snapshot, plugin
- [ ] specs/app-desktop-cli.md — packages/app, desktop, ui, cli entrypoints
- [ ] Обновить specs/index.md финальным агентом, commit
