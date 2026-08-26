# PrimeTime для моделей

## Стек проверки (ветка issue-primetime-models, worktree ~/wt/issue-primetime-models)
- `bun typecheck`: packages/core ✅, packages/schema ✅, packages/console/core ✅, packages/opencode ✅
- `bun test` packages/core: 1090 pass / 0 fail (включая session-runner-model.test.ts — 13/13)
- `bun test` packages/console/core: 14 pass / 0 fail
- `bun test` packages/schema: 2 падения в test/event-manifest.test.ts — предсуществующие,
  воспроизводятся на чистом main, не связаны с PrimeTime (см. TODO.md)
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

### 4. Интегрировать проверку — частично
- [x] `locationLayer.resolve`: pipeline `withVariant → checkPrimeTime → fromCatalogModel`
- [ ] Обработка `ModelPrimeTimeError` в processor.ts и вывод в TUI — не проверено end-to-end

### 5. Тестирование — частично
- [x] Починен test-сим `resolveForTesting`: теперь возвращает маршрутизированную `Model`
  (зеркалит продакшн-pipeline), тесты variant-overlay проверок route восстановлены (13/13)
- [ ] Отдельные тесты поведения prime-time (нужна инъекция времени — см. TODO.md)
- [ ] Фикс cross-midnight бага — предложен, ожидает подтверждения (см. TODO.md)

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

### Логика проверки
1. Если любое из полей отсутство/пусто — prime-time отключён
2. Текущий день недели должен входить в `primeTimeDay` (семантика: день текущего момента,
   т.е. окно 22:00–06:00 требует обоих дней в списке)
3. Текущее время между `primeTimeStart` и `primeTimeEnd` (переход через полночь — есть баг, см. TODO.md)
4. При нарушении — `ModelPrimeTimeError`

### Вывод ошибки
Сообщение: `Model {providerID}/{modelID} is in prime-time and cannot be used.`
