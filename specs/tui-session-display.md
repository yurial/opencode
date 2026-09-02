# TUI Session Display Specification

Status: draft
Spec source of truth for: reasoning visibility mode, reasoning duration display,
and persisted context-excluded meta parts in the terminal session screen.

## Overview

The terminal session screen renders the session transcript: messages and their
parts as persisted by the server. This spec fixes three display behaviors of
that screen: the persisted show/hide mode for reasoning bodies and its toggle
command; the elapsed-time indicator for reasoning parts, including parts that
carry no renderable text; and a meta part mechanism — a generic session part
type for display-only meta information that is persisted in the session
database and replayed with history, yet never enters provider context. The
first use of meta parts is surfacing stream errors and retry attempts that
would otherwise be visible only in server logs, transient toasts, or modal
dialogs.

## Scope

In: the reasoning display mode and its persistence; the `/thinking` toggle
command and its keybind; visibility and duration rendering of reasoning parts
(empty and non-empty, in-progress and finalized); the generic meta part type in
the session schema and its persistence; the provider-context exclusion of meta
parts in every session-to-provider message projection; stream-error and
retry-attempt meta parts as the first use; abort filtering for their creation;
rendering of meta parts as accumulated transcript lines.

Out (non-goals): server-side persistence or filtering of reasoning parts;
removing, reviving, or reusing the legacy persisted retry part type; cleanup,
compaction, or expiry of meta parts; the persisted error record on an assistant
message; toast, dialog, and notification surfaces (they remain as they are);
rendering of non-reasoning, non-meta parts; keybind plumbing beyond the single
command named here.

## Definitions

- `tui-session-display/thinking-mode` — The reasoning display mode of the
  session screen: exactly `"show"` or `"hide"`. `"hide"` collapses reasoning
  bodies to header lines; `"show"` renders bodies. Persisted TUI-locally, not
  in session history.
- `tui-session-display/empty-reasoning-part` — A reasoning part whose text is
  empty after trimming and after dropping provider placeholder payloads (for
  example encrypted-reasoning placeholders): it carries no renderable body.
- `tui-session-display/reasoning-timer` — The elapsed-time indicator of a
  reasoning part, derived only from the part's recorded start timestamp and,
  once present, end timestamp. Ticks live while the part is not finalized and
  is fixed afterwards.
- `tui-session-display/meta-part` — A generic persisted session part of a
  dedicated meta type, carrying a kind identifier and an opaque display
  payload. It is stored in the session database like any other part, replays
  with session history, renders as transcript lines, and is permanently
  excluded from provider context and from copied or exported transcripts.

## Interface

- Command `session.toggle.thinking`; slash command `/thinking`, alias
  `toggle-thinking`; menu title computed from the next mode: "Collapse thinking"
  when the next mode is `"hide"`, "Expand thinking" when it is `"show"`.
- Keybind `display_thinking` mapped to command `session.toggle.thinking`;
  default binding is unset (`none`). Users rebind it through the
  `keybinds.<command>` channel of the TUI config file (config-v1).
- TUI-local key-value key `thinking_mode`: value `"show"` | `"hide"`, default
  `"hide"`. Legacy key `thinking_visibility` (boolean) is migrated on first
  read when no `thinking_mode` value exists. No config-file key exists for the
  mode; it changes only through the command.
- Meta part (schema element): a new part type in the session part schema,
  generic and not retry-specific:
  - `type`: literal `"meta"`.
  - `id`, `sessionID`, `messageID`: standard part identity; the part belongs
    to the message in whose run the information arose.
  - `kind`: string naming the information class (first kinds: retry attempt,
    stream error).
  - `payload`: record of string to any — opaque display data interpreted only
    by the kind's renderer, never by provider-context construction.
  - No dedicated timestamp field: transcript ordering derives from the part
    identifier ordering shared by all parts.
  The legacy persisted retry part type stays in the schema untouched, dead:
  this mechanism neither revives nor extends it.
- Context exclusion: every projection of persisted session parts into provider
  messages (the V2 runner message projection and the V1 session message
  projection) excludes the meta type by an explicit type check, never by
  accidental fall-through.

## Configuration

No new config keys: the live timer and the elapsed format are fixed display
behavior, not tunables. Existing entries this spec fixes:

| Name | Allowed values | Default | Effect |
|---|---|---|---|
| `thinking_mode` | enum: `show`, `hide` (TUI-local KV key) | `hide` | Reasoning body visibility (R1, R3); changed only by `session.toggle.thinking` (R2) |
| `display_thinking` | `fixed` default binding `none` (keybind identifier) | — | No default key; binding the command is done via the config-v1 `keybinds.<command>` channel (R2) |
| `0` ms, reasoning elapsed lower bound | `magic` 0 ms | — | A negative end−start difference renders as zero elapsed time (R6) |

## Behavior

- R1. The session screen maintains a `tui-session-display/thinking-mode` with
  exactly the values `"show"` and `"hide"`; the default is `"hide"`. The mode
  is stored under the TUI-local KV key `thinking_mode` and restored on
  restart. When no `thinking_mode` value exists but the legacy boolean key
  `thinking_visibility` does, it migrates once: `true` → `"show"`, `false` →
  `"hide"`. A stored value outside the mode set (for example `"minimal"`) is
  coerced to `"hide"`.
- R2. Invoking `session.toggle.thinking` sets the
  `tui-session-display/thinking-mode` to the next value in the cycle
  `show → hide → show` and persists it. The change applies immediately to all
  reasoning parts displayed in the open session screen, without restart or
  reload. Example: mode `"show"`, user runs `/thinking` → mode becomes
  `"hide"`, bodies collapse at once, next start shows `"hide"`.
- R3. For a reasoning part with a non-empty body: in `"hide"` mode only the
  header line is rendered; the body is revealed by per-part local expansion
  (toggled on the header) and hidden again by a second toggle. Expansion state
  is local to the part and resets when the part unmounts; it has no effect in
  `"show"` mode, where bodies are always rendered.
- R4. A reasoning part is never dropped from the transcript for lack of text:
  an `tui-session-display/empty-reasoning-part` renders a header line carrying
  the `tui-session-display/reasoning-timer` and no body, in either mode;
  expansion has nothing to reveal. Non-empty parts keep body rendering per R3.
- R5. While a reasoning part is not finalized (no end timestamp), the
  `tui-session-display/reasoning-timer` ticks live: it displays
  now − start and re-renders continuously while the part is displayed. An
  empty part's line reads `Reasoning: <elapsed>` (for example
  `Reasoning: 12.3s`, then `Reasoning: 1m 5s`). A non-empty in-progress part
  keeps its current spinner header without any duration.
- R6. When the part is finalized (end timestamp set), the timer is fixed at
  end − start — never negative; a negative difference renders as zero — and
  stops ticking. A finalized empty part shows `Reasoning: <elapsed>`; a
  finalized non-empty part keeps its current `Thought` header with optional
  summary title and ` · <elapsed>` suffix. Elapsed time is rendered by the
  standard TUI duration formatting (the `mm:ss`-style humanized form).
  Example: start 100000, end 165000 → `Reasoning: 1m 5s` on an empty part,
  `Thought · 1m 5s` on a part without summary title.
- R7. Reasoning timestamps are server-authored: start is set when the part is
  created, end when reasoning finishes for that part, independently of the
  parent assistant message completing. The fixed duration is computed solely
  from the persisted timestamps, so reloading a session renders the same fixed
  value. A part persisted without an end timestamp is displayed as in-progress
  (live timer from its start).
- R8. The session schema provides a generic meta part (the schema element
  above). A `tui-session-display/meta-part` is persisted server-side in the
  session database like any other part, belongs to the message in whose run it
  arose, and replays with session history. It is generic: any display-only
  meta information may be persisted through it, keyed by its kind; the
  mechanism is not retry-specific. The legacy persisted retry part type
  remains unused and unchanged.
- R9. Each `tui-session-display/meta-part` renders as one accumulated
  transcript line in the session screen, on the same surface as reasoning
  parts, in part order (event order). Lines accumulate: there is no
  auto-dismiss, no timeout, no expiry, and no cleanup of persisted meta parts
  — they survive client restarts and re-render on every session replay.
  Repeated identical failures persist separate parts (no deduplication).
  Example: two failed attempts followed by success → two lines persist in the
  session and reappear after restart.
- R10. A `tui-session-display/meta-part` never enters provider context: every
  projection of persisted parts into provider messages (the V2 runner message
  projection and the V1 session message projection) excludes the meta type by
  an explicit type check, for every session, forever. Testable: no provider
  request payload ever contains `tui-session-display/meta-part` content, for
  any kind.
- R11. A `tui-session-display/meta-part` never appears in copied or exported
  session transcripts; transcript copy and export operate on non-meta parts
  only. Meta parts are session-database truth for the session screen, not
  content for sharing.
- R12. Creation policy: every retry attempt of a session's assistant run
  persists one `tui-session-display/meta-part` (kind retry attempt) carrying
  the attempt number and the error description in its payload; a terminal
  stream error persists one `tui-session-display/meta-part` (kind stream
  error) carrying the error description. User-initiated aborts (the
  aborted-message error class) persist no meta part, matching the existing
  abort filter of the error toast.
- R13. A terminal failure persists the error on the assistant message and
  finishes it with an error status exactly as before. Meta parts are additive:
  they never replace, suppress, or alter that persisted record or its existing
  event and toast surfaces.

## Constraints

- The provider-context boundary is absolute: `tui-session-display/meta-part`
  content may appear in the session database, in replayed history, and in the
  session screen — never in a provider request or any LLM context built from
  session parts. A code change that routes meta-part content into a provider
  message projection is a spec violation, not an implementation detail; the
  exclusion must be an explicit type check, never an implicit fall-through.
- The legacy persisted retry part type is not to be revived, extended, or
  duplicated: it stays dead in the schema, and no second meta mechanism may
  appear alongside the one specified here.
- Reasoning duration rendering derives only from the part's persisted
  timestamps; the client never extrapolates a finalized part's duration from
  the wall clock.
- The meta part type is a wire schema change: adding it to the session part
  union requires regenerating the SDK clients, and the change must be recorded
  in the V2 schema change ledger (v2-schema-changelog) when that ledger is
  next updated.

## Error handling

- Recoverable stream error (retried by the server retry policy): one
  `tui-session-display/meta-part` is persisted per attempt and rendered as an
  accumulating line (R9, R12); the run continues.
- Terminal stream error: one `tui-session-display/meta-part` is persisted
  (R12) and, unchanged, the error is persisted on the assistant message with
  its existing event and toast surfaces (R13).
- User-initiated abort: no meta part is created (R12) and the abort is
  filtered from the error toast, as today.
- Persistence degradation: a failure to persist or render a meta part must not
  change the run's outcome, the assistant error record, or other transcript
  rendering; the worst outcome is a missing or malformed line.

## Dependencies

- config-v1 — the `display_thinking` keybind default recorded above and user
  rebinding of `session.toggle.thinking` through the `keybinds.<command>`
  channel of the TUI config file.

## Used by

None yet.

## Verification

None. No formal verification (TLC/TLAPS) exists for this component; the
requirements are intended to be covered by ordinary TUI tests once implemented.
