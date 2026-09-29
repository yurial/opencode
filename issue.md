# issue: миграция V1→V2 должна сохранять наши ключи (уход от необходимости в v2-конфиге)

Цель: чтобы V1-документ `~/.config/opencode/opencode.json` после миграции
`ConfigMigrateV1` полноценно нёс `subagent_depth` и `discard_context`, и
отдельный `opencode.jsonc` стал не нужен.

Контекст: V2-ядро (`packages/core/src/config.ts`) мигрирует V1-документы;
`discard_context` мигратором сохраняется (проверить фактически), а
`subagent_depth` есть только в V1-схеме (`packages/core/src/v1/config/config.ts:87`)
— в V2-схеме (`Config.Info`) и в миграторе его нет, ключ теряется молча
(зафиксировано в корневом TODO.md апстрима, ~строки 93-97).

## Подзадачи

- [x] 1. Верифицировать фактическое поведение `discard_context` в V1-документе:
      сохраняется ли мигратором и потребляется ли V2-ядром (тест).
      Итог: сохранялся мигратором (migrate.ts, `discard_context`) и присутствовал
      в V2-схеме; добавлен регрессионный тест.
- [x] 2. Добавить `subagent_depth` в V2-схему конфига (`Config.Info`,
      packages/core/src/config.ts) с тем же типом/дефолтом, что в V1-схеме.
- [x] 3. Добавить перенос `subagent_depth` в `ConfigMigrateV1.migrate`
      (packages/core/src/v1/config/migrate.ts).
- [x] 4. Тесты: V1-документ с `provider`+`permission`+`small_model`+
      `subagent_depth`+`discard_context` после загрузки V2-ядром сохраняет
      оба ключа; дефолты не ломаются; существующие тесты миграции зелёные.
- [x] 5. Прогнать тесты конфига/миграции; при успехе — squash в один коммит
      build-ok с развёрнутым сообщением.
