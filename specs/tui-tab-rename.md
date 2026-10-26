# TUI tmux Tab Rename

Status: stable

## Goal

Rename the tmux window (tab) to the current session title. tmux ignores OSC 0/2
pane titles (`renderer.setTerminalTitle`) for window names; the only path that
renames the tab is the screen-legacy sequence `ESC k <name> ESC \` and only when
tmux `allow-rename` is on. Outside tmux the sequence would print garbage, so
emission is gated on the environment.

## Interface

- `tui.json` / legacy `opencode.json` `tui` section parameter `tab_rename`
  (boolean, default `true`), defined in `@opencode-ai/tui/config`
  (`packages/tui/src/config/index.tsx`): `Info` schema with description,
  `Resolved` type, and `resolve()` default. Legacy `opencode.json`
  `tui.tab_rename` reaches the TUI through the tui-config migration
  (`packages/opencode/src/config/tui-migrate.ts` `normalizeTui`), which moves it
  into `tui.json` when that file does not exist yet.
- Sanitizer `tmuxTabSequence(input)` (`packages/tui/src/util/tmux-tab.ts`):
  pure function returning the full `\x1bk<name>\x1b\\` byte sequence or
  `undefined` when nothing may be written. Sanitization: strip ANSI (strip-ansi),
  collapse newlines to spaces, drop C0/C1 control characters, trim, truncate to
  60 code points without splitting surrogate pairs. Empty result → skip.
- Emission lives in the TUI app (`packages/tui/src/app.tsx`, next to the
  terminal-title effect): when `tab_rename` is on and `process.env.TMUX` is
  non-empty, on route entering a session and on `session.title` changes of the
  current session, write the sequence via `process.stdout.write` (same pattern
  as `packages/tui/src/clipboard.ts` `writeOsc52`).

## Rules

- R1. Emission only inside tmux: `process.env.TMUX` non-empty. No TTY guard is
  added on top; the renderer already owns stdout in the TUI process.
- R2. Sessions with a default placeholder title (`isDefaultTitle`) do not rename
  the tab; the previous tab name is left untouched.
- R3. The trigger reads the session title from the legacy sync store
  (`packages/tui/src/context/sync.tsx` `session.updated`), which both engines
  feed: v1 publishes `SessionV1.Event.Updated` from `Session.setTitle`, and v2
  reuses the same event vocabulary (`SessionV2.create` publishes
  `SessionV1.Event.Created`; the v2 projector consumes
  `SessionV1.Event.Updated`). v2 automatic title generation is not implemented
  yet (`packages/core/src/session/runner/llm.ts` TODO); until it lands, v2
  renames happen on session switch and on manual/API title updates only.
- R4. The existing `terminal_title_enabled` KV option and its pane-title effect
  are independent; `tab_rename` does not read or change them.
- R5. The sanitizer and the write/skip decision stay pure and unit-tested;
  `process.stdout.write` is the only side effect and sits at the call site.
