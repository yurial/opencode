# issue: команда /delete в TUI

Задача: добавить slash-команду `/delete` в интерактивный TUI opencode.

## Поведение (согласовано с пользователем)
1. `/delete` без аргументов: открывается диалог списка сессий (DialogSessionList, как `/sessions`). Удаление текущей сессии происходит ТОЛЬКО после того, как пользователь выбрал в диалоге другую сессию: сначала выбор → затем удаление текущей сессии (`sdk.client.session.delete({ sessionID: route.sessionID })`) → переключение на выбранную. Если пользователь отменил выбор (закрыл диалог) — удаление НЕ происходит.
2. `/delete <sessionID>`: удаляет сессию с указанным ID (текущая не трогается, диалог не открывается).

## Подзадачи
- [x] Добавить команду с slashName `delete` в `sessionCommandList` (`packages/tui/src/routes/session/index.tsx`), поддержка опционального аргумента sessionID (см. как другие slash-команды принимают аргументы, напр. /rename).
- [x] Handler без аргумента: открыть DialogSessionList; при выборе сессии — удалить текущую, затем navigate на выбранную; при отмене — ничего. Паттерн ошибок удаления — `dialog-session-list.tsx:310-335` (toast / DialogSessionDeleteFailed при необходимости).
- [x] Handler с аргументом: удалить указанную сессию, ошибка — toast.
- [x] Учёт: авто-переход на home при `session.deleted` текущей сессии уже есть (`app.tsx:1010-1018`) — не должен конфликтовать с последующим navigate на выбранную сессию.
- [x] Тесты: unit-тесты логики команды в стиле существующих тестов `packages/tui/test` (мок SDK через `test/fixture/tui-sdk.ts`).
- [x] `bun test` и `bun typecheck` из `packages/tui` — зелёные.

## Заметки по реализации
- Локальные slash-команды в TUI диспатчатся по имени без аргументов (autocomplete вызывает
  `keymap.dispatchCommand(name)`), поэтому для поддержки `/delete <sessionID>` добавлена ветка в
  `submitInner` промпта (`packages/tui/src/component/prompt/index.tsx`): серверные команды сохраняют
  приоритет, остальные тексты вида `/name args...` диспатчатся в зарегистрированную palette-команду
  с аргументами в `payload` (`parseSlashCommand` + `slashCommandByName` + `slashCommandArg` в
  `packages/tui/src/keymap.tsx`).
- Выбор текущей сессии в режиме `/delete` трактуется как отмена (закрыть диалог без удаления);
  решение зафиксировано в `resolveSessionSwitch` (`packages/tui/src/component/dialog-session-list.tsx`).
- Гонка с авто-переходом на home при `session.deleted` безопасна при любом порядке событий
  (см. комментарий в onSelect dialog-session-list).
