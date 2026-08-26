# TODO

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
  result when HTML-to-Markdown conversion throws"): флакирует при полной нагрузке прогона
  (в т.ч. с --coverage), воспроизводится на чистом main; изолированный запуск проходит.
- `packages/opencode/test/provider/header-timeout.test.ts` ("chunkTimeout raises a response
  stream error when SSE body stalls"): падает и на чистом main, и с изменениями PrimeTime
  (SSE read timed out); не зависит от ветки.
