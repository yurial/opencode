# PrimeTime для моделей

## Стек проверки (ветка issue-primetime-models, worktree ~/wt/issue-primetime-models)
- `bun typecheck`: packages/core ✅, packages/schema ✅, packages/console/core ✅, packages/opencode ✅
- `bun test` packages/core: 1100 pass / 0 fail (session-runner-model.test.ts — 23/23,
  включая 10 prime-time тестов); при полной нагрузке флакит посторонний tool-webfetch.test.ts
  (предсуществующее, см. TODO.md)
- `bun test` packages/console/core: 14 pass / 0 fail
- `bun test` packages/schema: 2 падения в test/event-manifest.test.ts — предсуществующие,
  воспроизводятся на чистом main, не связаны с PrimeTime (см. TODO.md)
- Покрытие `src/session/runner/model.ts`: branch 90.75% (main) → 92.23%; `checkPrimeTime` — 100%;
  оставшиеся дыры — те же, что на main (message-геттеры ошибок, ветки locationLayer)
- Клиентский SDK не затронут: ModelV2 отсутствует в packages/client/src/generated* и protocol, regen не нужен

## Задачи

### 1. Добавить поля в Schema модели — ✅ выполнено
- [x] `primeTimeStart: Schema.String.pipe(optional)` в `packages/schema/src/model.ts`
- [x] `primeTimeEnd: Schema.String.pipe(optional)` в `packages/schema/src/model.ts`
- [x] `primeTimeDay: Schema.Array(Schema.Literals(["sun".."sat"])).pipe(optional)` в `packages/schema/src/model.ts`

### 2. Обновить SQL схему — ✅ выполнено
- [x] `prime_time_start` / `prime_time_end` / `prime_time_day` — nullable text-колонки в `ModelTable`
  (`packages/console/core/src/schema/model.sql.ts`); исправлена compile-ошибка `.pipe(optional)`
- Примечание: SQL-миграции генерируются отдельным процессом (`chore: generate`), TS-схема коммитится без миграции

### 3. Создать ошибку PrimeTime — ✅ выполнено
- [x] `ModelPrimeTimeError` в `packages/core/src/session/runner/model.ts`
- [x] Проверка `checkPrimeTime` в том же файле (входит в `Error`-union резолвера)
- Замечание: известный баг cross-midnight — см. TODO.md

### 4. Интегрировать проверку — ✅ выполнено
- [x] `locationLayer.resolve`: pipeline `withVariant → checkPrimeTime → fromCatalogModel` (V2-путь)
- [x] V1-путь (основной для TUI/server): поля `primeTimeStart/End/Day` в `ConfigProviderV1.Model`
      (`packages/core/src/v1/config/provider.ts`) + предикат `primeTimeActive` (единая логика окна);
      поля в runtime `Provider.Model` (`packages/opencode/src/provider/provider.ts`) с мержем из конфига;
      гейт в начале `LLM.run` (`packages/opencode/src/session/llm.ts`) — fail до любого резолва/сети
- [x] Обработка в processor.ts: ошибка → `Effect.catch(halt)` → `MessageV2.fromError` →
      `NamedError.Unknown` → `assistantMessage.error` + `Session.Event.Error` → отображение в TUI;
      не матчится с ретрай-паттернами → без ретраев
- [x] Тест end-to-end: `llm.test.ts` "refuses to stream when the model is inside its
      prime-time window" — конфиг → Provider.Model маппинг полей, drain падает с сообщением
      "is in prime-time", HTTP-запросы не отправляются

### 5. Тестирование — ✅ выполнено
- [x] Починен test-сим `resolveForTesting`: теперь возвращает маршрутизированную `Model`
      (зеркалит продакшн-pipeline), тесты variant-overlay проверок route восстановлены
- [x] Отдельные тесты поведения prime-time с инъекцией времени (`checkPrimeTime(model, now)`)
- [x] Интеграционный тест V1-пути в `packages/opencode/test/session/llm.test.ts`

### 6. Фикс cross-midnight + тесты — ✅ выполнено
- [x] `checkPrimeTime(model, now)`: сравнение через seconds-of-day, переход через полночь
      как `current >= from || current <= to`
- [x] Экспортирована `checkPrimeTime` с инъекцией времени
- [x] Убран дубль проверки в `locationLayer` (одна проверка до provider/credential lookup;
      `resolveForTesting` зеркалирует тот же порядок)
- [x] Тесты: same-day в/вне окна, cross-midnight вечер/утро/до старта, inclusive-границы,
      день не в списке, без конфигурации, всегда-блокирующая модель через `resolveForTesting`

## Реализация

### Формат данных
- `primeTimeStart`: строка "HH:MM:SS"
- `primeTimeEnd`: строка "HH:MM:SS"
- `primeTimeDay`: подмножество ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

### Пример конфигурации
```json
{
  "primeTimeStart": "22:00:00",
  "primeTimeEnd": "06:00:00",
  "primeTimeDay": ["mon", "tue", "wed", "thu", "fri", "sat"]
}
```

### Логика проверки (предикат `ConfigProviderV1.primeTimeActive`)
1. Если любое из полей отсутствует/пусто — prime-time отключён
2. Текущий день недели должен входить в `primeTimeDay` (семантика: день текущего момента,
   т.е. окно 22:00–06:00 требует обоих дней в списке)
3. Сравнение через seconds-of-day; `start <= end` — интервал того же дня (границы inclusive),
   `start > end` — окно через полночь (`current >= from || current <= to`)
4. V2-путь: нарушение → `ModelPrimeTimeError`; V1-путь: `Effect.fail(Error)` в `LLM.run`

### Вывод ошибки
- V2: `Model {providerID}/{modelID} is in prime-time and cannot be used.`
- V1 (TUI/server): `Model {providerID}/{modelID} is in prime-time ({start}–{end} on {days}) and cannot be used.`

### Где настраивается (V1)
`opencode.json` → `provider.<providerID>.models.<modelID>`:
```json
{
  "provider": {
    "openai": {
      "models": {
        "gpt-5.2": {
          "primeTimeStart": "22:00:00",
          "primeTimeEnd": "06:00:00",
          "primeTimeDay": ["mon", "tue", "wed", "thu", "fri", "sat"]
        }
      }
    }
  }
}
```
