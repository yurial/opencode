# Specification Deviations

## D-001 2026-09-02 specs/tui-session-display.md
Change: R4–R7 — empty reasoning parts (including placeholder-stripped ones)
  become visible with a `tui-session-display/reasoning-timer` line
  ("Reasoning: <elapsed>", live while streaming, fixed after finalization)
  instead of being dropped from the transcript. R8–R13 — stream errors and
  retry attempts become persisted meta parts (`tui-session-display/meta-part`):
  a new generic session part type stored in the session database like any
  other part, rendered as accumulated transcript lines forever (no
  auto-dismiss, no cleanup, survives restarts), and permanently excluded from
  provider context and copied/exported transcripts.
Was: reasoning parts whose text was empty (or empty after dropping the
  encrypted-reasoning placeholder) rendered nothing at all; mid-stream
  retried errors were visible only in server logs, retry attempts only as
  session-status flips driving modal dialogs, and errors only as 5-second
  auto-dismissing toasts; no record of attempts survived the run.
Now: every reasoning part renders at least a header line — empty parts show
  "Reasoning:" with a live-then-fixed elapsed time derived from the part's
  timestamps; stream errors and each retry attempt persist as meta parts
  (kind + payload) that replay with session history and re-render after
  restart, while never entering any provider message projection; terminal
  errors keep their existing persisted assistantMessage.error record (R13).
Design note: a new generic part type (`type: "meta"`, `kind` + `payload`)
  was chosen over reviving the dead RetryPart — RetryPart's payload
  (attempt number, APIError) is retry-specific and cannot carry arbitrary
  display meta, an explicit `"meta"` type check makes the provider-context
  exclusion robust for all future kinds, and nothing ever wrote RetryPart so
  no data or dual mechanism is at stake. RetryPart stays dead; its removal
  is a separate decision.
Code impact: packages/schema/src/v1/session.ts — add the meta part to the
  session part union (wire schema change: regenerate SDK via
  ./packages/sdk/js/script/build.ts and `bun run generate` in packages/client;
  record in specs/v2/schema-changelog.md when the v2 ledger is next updated).
  packages/opencode/src/session/processor.ts — persist meta parts through the
  session part write path from the retry callback and the terminal-error
  (halt) path. Context filter: packages/core/src/session/runner/
  to-llm-message.ts (V2 runner projection) and packages/opencode/src/session/
  message-v2.ts (V1 message projection loop over parts) must exclude the meta
  type by an explicit type check. packages/tui/src/routes/session/index.tsx —
  remove/bypass the empty-content `<Show>` guard in ReasoningPart and add the
  "Reasoning: <elapsed>" header for empty parts; add a meta part renderer to
  PART_MAPPING (accumulated lines); exclude meta parts from transcript
  copy/export formatting. packages/tui/src/context/thinking.ts and the
  `/thinking` command are already conforming (R1–R3 fix existing behavior).
Tests: tests/snapshots asserting empty reasoning parts render nothing must be
  replaced (empty-part timer rendering; fixed duration from persisted
  timestamps; live tick while unfinalized); add tests for meta-part
  persistence and replay across restart, accumulation (one part per attempt,
  no dedup, no cleanup), the explicit provider-context exclusion (provider
  request payloads never contain meta content, both projections), abort
  filtering, and copy/export exclusion; SDK generation must be clean.
Review focus: meta-part content never appears in a provider request, in any
  LLM context projection, or in copied/exported transcripts (explicit type
  checks in both projections, no accidental fall-through); meta parts persist
  to the session database, replay, and are never garbage-collected or
  auto-dismissed; aborted (MessageAbortedError-class) failures create no meta
  part; terminal assistantMessage.error persistence and its event/toast
  surfaces are unchanged; RetryPart is not revived or extended;
  `[REDACTED]`-stripped parts are treated as empty and get the same timer
  line; SDK regenerated and schema change recorded in the v2 changelog ledger.
