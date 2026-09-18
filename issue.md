# issue: interactive tool

Спека: `specs/tool-interactive.md` (a5510f3d0). Цель — V2-инструменты
`interactive_start/write/wait/cancel` для интерактивных процессов (gdb, REPL).

## Подзадачи

- [x] 1. Интерфейсы без реализации: типы job'а, статусы, конфиг `interactive.*`,
      схемы ввода/вывода 4 инструментов, точки в registry/runner
      (packages/core/src/tool, packages/schema) — 9ae733575
- [x] 2. Описания контрактов (doc comments) для всех новых интерфейсов — в 9ae733575
- [ ] 3. Тесты под ожидаемое поведение (fake interactive process,
      детерминизм автоцикла, губернатор, bounding, permissions).
- [ ] 4. Реализация: PTY spawn, spool, auto-feed через V2 continuation,
      ledger сирот, Tool.Progress.
- [ ] 5. typecheck + тесты зелёные; squash-коммит.
