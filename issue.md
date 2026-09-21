# Задача: доля токенов для частичного дискорда + сайдбар-панель статистики

Решения пользователя: доля по объёму текста (char-weighted), суффикс «~» для оценённых сумм,
builtin-виджет в правом сайдбаре (слот sidebar_content, hide-on-empty).

## 1. Спека
- [x] specs/discard-context.md: R7.1/R7.2 (доля), R7.8 («~»), R9.1–R9.4 (сайдбар), A7.2/A7.8/A7.9, A9.x, T4.2/T4.9/T7.x, J2/J13/J14
- [x] specs/GLOSSARY.md: discarded-token-total, fully-discarded-message, + part-char-weight, partially-discarded-message
- [x] specs/index.md: сводка синхронизирована

## 2. Доля токенов в коде (зеркала байт-в-байт идентичны, constraint спеки)
- [ ] packages/tui/src/util/discard-context.ts: {total, estimated}, вес части (text/reasoning — length(text); tool — length(output)+length(JSON.stringify(input))), floor, нулевой вес → 0
- [ ] packages/session-ui/src/components/discard-context-summary.ts: то же самое синхронно
- [ ] Вызовы: routes/session/index.tsx (DiscardContext label «· ~1.2M tokens»), util/transcript.ts, session-ui message-part.tsx
- [ ] Тесты: tui test/util/discard-context.test.ts, session-ui discard-context-summary.test.ts, tui test/util/transcript.test.ts (T4.2, T4.9, суффиксы)

## 3. Сайдбар-виджет
- [ ] packages/tui/src/feature-plugins/sidebar/discard-stats.tsx: 3 строки (union частей, total с «~», число вызовов), hide-on-empty, по образцу context.tsx
- [ ] Регистрация в packages/tui/src/feature-plugins/builtins.ts
- [ ] Тесты packages/tui/test/feature-plugins/sidebar-discard-stats.test.tsx (T7.1–T7.4)

## 4. Финализация
- [ ] bun typecheck (packages/tui, packages/session-ui), тесты из пакетных директорий
- [ ] build-ok squash, развязка precommit-ов
- [ ] TODO.md актуален
- [ ] Merge в main по ритуалу, синк, отчёт
