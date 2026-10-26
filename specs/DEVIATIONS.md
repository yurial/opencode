# Specification Deviations

## D-001 2026-10-26 specs/scheduler.md
Spec edit: Interface (arguments, error results, gate echo), R1.4, R1.5, R3.13 — the optional
  `command` argument of the scheduler tool add.
Was: the tool accepts no `command`; add and list results echo no gate fragment; no
  `command-too-long` error exists.
Now: an add may carry `command` (non-empty string, at most SCHEDULER_MAX_COMMAND_LENGTH
  characters); add and list lines of a gated schedule end with the single-line gate echo;
  an over-long command returns `command-too-long`.
Code impact: packages/opencode/src/tool/scheduler.ts (parameters schema, validation, error
  code, result text), packages/opencode/src/tool/scheduler.txt (argument description),
  packages/core/src/scheduler/message.ts (`added` and `listed` gate-echo fragment with
  whitespace-run collapse).
Tests: packages/opencode/test/tool/scheduler.test.ts — gate-argument validation and echo
  tests (T1.6, T1.7, T3.14).
Review focus: an absent `command` keeps add, list, and fired output byte-identical; the
  gate echo never precedes the `next due` fragment of its line and never introduces a line
  break (annotator input contract of scheduler-view).

## D-002 2026-10-26 specs/scheduler.md
Spec edit: R5.5, R6.11-R6.18, R7.1, R7.7-R7.9, R8.6-R8.11, I4, I8-I11, Configuration
  (SCHEDULER_GATE_*, SCHEDULER_MAX_COMMAND_LENGTH, SCHEDULER_MAX_GATE_OUTPUT_LENGTH) — gate
  execution, suppression, catch-up interplay, and loop isolation.
Was: the delivery loop delivers every due row unconditionally; no command execution, no
  suppression bookkeeping, no in-flight tracking; fired messages carry no output section.
Now: a gated schedule runs its command outside the write permit before any delivery side
  effect; status zero delivers with the bounded gate-output-section appended to the fired
  message; nonzero suppresses — a recurring schedule advances from the discharged
  scheduled-fire-time, a one-shot is removed — with no retry and no delivery-failure
  marking; a catch-up fire runs the command once per skipped series; at most one gate-run
  per schedule is in flight, held due times resolve as catch-up fires, and the loop keeps
  serving other schedules.
Code impact: packages/core/src/scheduler/scheduler.ts (gate phase between startFire and
  finishFire, in-flight set, due-scan and timer-arm skip, suppression branch of finishFire),
  packages/core/src/scheduler/message.ts (gate-output-section rendering), process command
  runner dependency on the service node (AppProcess.node precedent per the V2 bash tool).
Tests: packages/core/test/scheduler-service.test.ts — fake command-execution layer plus
  TestClock advancement (T5.5, T6.9-T6.15, T7.7-T7.10, T8.4-T8.8); real spawn behavior per
  packages/core/test/process/process.test.ts.
Review focus: the write permit is never held across a gate-run (I9); suppression never
  enters the failed-delivery retry path (no command hot loop); a held occurrence never
  starts a second concurrent run; the loop keeps serving other schedules during a flight;
  command output is discarded on suppression.

## D-003 2026-10-26 specs/scheduler.md
Spec edit: Interface schedule record, R4.1, R4.3 — the nullable `command` column of the
  schedule table.
Was: the schedule table has no `command` column; the schedule entry type carries no gate
  field.
Now: the table stores the nullable command text, the schedule entry carries it, and the
  column registers through the generated migration pipeline.
Code impact: packages/core/src/scheduler/sql.ts (nullable `command` column), `bun run
  migration` from packages/core (generated ADD COLUMN migration and regenerated
  migration.gen.ts/schema.gen.ts), row mapping in scheduler.ts.
Tests: extend the migration-registration test of packages/core/test/scheduler-service.test.ts.
Review focus: the column is nullable with no default so existing rows decode with no gate;
  the migration comes from the drizzle snapshot pipeline, not a hand-written SQL file.

## D-004 2026-10-26 specs/scheduler-view.md
Spec edit: R3.2, Interface schedule-entry fields — the `command` field of the
  schedule-list endpoint response.
Was: the endpoint maps entries to exactly `id`, `spec`, `message`, and `nextFireAt`, and
  the protocol schema declares exactly those fields.
Now: every schedule-entry also carries `command`, a string or null, null when the schedule
  stores no gate command.
Code impact: packages/protocol/src/groups/session.ts (SessionSchedule schema),
  packages/server/src/handlers/session.ts (entry mapping), `bun run generate` from
  packages/client and the legacy SDK build per AGENTS.md; ledger entry added in
  specs/v2/schema-changelog.md.
Tests: endpoint field assertion (T3.8).
Review focus: `command` is present on every entry (null when none) rather than an optional
  key; the regenerated client and legacy SDK surfaces land with the protocol change.

## D-005 2026-10-26 specs/scheduler-view.md
Spec edit: R4.4, Interface sidebar entry line, Configuration
  (SCHEDULER_VIEW_SIDEBAR_GATE_MARKER) — the gate-command indicator of the sidebar block.
Was: the sidebar entry line renders no gate indication.
Now: an entry with a non-null `command` appends the marker literal directly after its
  schedule id, without consuming the shortened-message budget.
Code impact: packages/tui/src/feature-plugins/sidebar/scheduler.tsx (entryLine marker).
Tests: sidebar marker assertion (T4.13).
Review focus: a null `command` renders the entry line exactly as before; the marker does
  not shorten the message portion.
