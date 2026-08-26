# TODO

## PrimeTime (packages/core/src/session/runner/model.ts)

- **Таймзона не определена.** Проверка использует локальное время процесса. Нужно решение:
  UTC, локальная таймзона сервера или таймзона workspace.
- **Малформированные значения отключают prime-time.** `primeTimeStart`/`primeTimeEnd` — произвольные
  строки (`Schema.String`); формат без секунд или с мусором даёт NaN в seconds-of-day → сравнения
  false → ограничение молча не действует (fail-open, зафиксирован в контракте `checkPrimeTime`).
  Решение: валидация формата в схеме или fail-closed.

## Не связано с PrimeTime (предсуществующее на main)

- `packages/schema/test/event-manifest.test.ts`: 2 падения на чистом main
  (порядок/идентификаторы манифеста событий). Воспроизведено без изменений PrimeTime.
- `packages/core/test/tool-webfetch.test.ts` ("WebFetchTool registration > returns an error
  result when HTML-to-Markdown conversion throws"): флакирует при полной нагрузке прогона
  (в т.ч. с --coverage), воспроизводится на чистом main; изолированный запуск проходит.
