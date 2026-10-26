# Specification Deviations

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
