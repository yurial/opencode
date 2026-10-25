# Specification Deviations

## D-1 2026-10-25 specs/scheduler-view.md
Spec edit: new spec, R1 subtree — the output text of completed scheduler tool
  results gains appended annotation lines.
Was: the scheduler tool's result text carries only its own lines per scheduler
  R1.4-R1.6; no annotation exists; no builtin host plugin acts on scheduler tool
  results.
Now: every completed scheduler tool result whose output text carries a
  `next due <instant>` fragment carries appended annotation lines with the
  relative eta and the absolute UTC time (scheduler-view R1.3, R1.4).
Code impact: new builtin host plugin under `packages/opencode/src/plugin/`
  registered in `internalPlugins()`; `tool.execute.after` hook filtering on the
  `scheduler` tool name; parsing and appending per scheduler-view I1, I2. The
  tool core, the result title, and the result metadata stay untouched
  (scheduler-view R1.5, R1.7). This entry is deleted in the commit that lands
  the conforming plugin with its tests.
Tests: annotator hook tests per scheduler-view T1 (annotation on every action;
  title and metadata unchanged; remove and error results unchanged; internal
  failure leaves the result intact).
Review focus: append-only mutation of the output text; no metadata or title
  changes; no scheduler/service query inside the hook; annotation order follows
  the tool's own text.

## D-2 2026-10-25 specs/scheduler.md
Spec edit: Overview and Out narrowed — the HTTP prohibition covers the
  scheduler core only; scheduler-view R3 subtree prescribes the read-only
  schedule-list endpoint.
Was: no HTTP route serves schedules; `GET /api/session/:sessionID/schedule`
  does not exist — no protocol endpoint, no handler, no generated client
  operation.
Now: the route returns the session's schedules as schedule-entry values ordered
  by nextFireAt with the error set of the scheduler-view Interface
  (scheduler-view R3.1-R3.7).
Code impact: endpoint declaration in the `server.session` group of
  `packages/protocol/src/groups/session.ts`; handler in
  `packages/server/src/handlers/` listing through the already-bound
  scheduler/service node; client regeneration (`bun run generate` from
  `packages/client`) and legacy SDK regeneration
  (`./packages/sdk/js/script/build.ts`); a ledger entry in
  `packages/opencode/specs/v2/schema-changelog.md` when next updated. This entry
  is deleted in the commit that lands the route with its tests and both
  regenerated client surfaces.
Tests: endpoint tests per scheduler-view T3 (list shape and order;
  epoch-millisecond nextFireAt; unknown session not found; undecodable id
  invalid request; read-only, no permission ask).
Review focus: response session-scoped and read-only; `{data}` body without the
  location envelope; errors resolved through the session-location middleware;
  both generation flows ran after the protocol change.

## D-3 2026-10-25 specs/scheduler-view.md
Spec edit: new spec, R4 subtree — the TUI sidebar gains the always-on schedules
  block.
Was: no builtin TUI feature plugin renders schedules; the sidebar has no
  schedules block.
Now: the block registers in the `sidebar_content` slot at
  SCHEDULER_VIEW_SIDEBAR_SLOT_ORDER, fetches through the SDK client from the
  schedule-list endpoint, renders entry lines with the shared eta grammar, and
  refreshes on session change, scheduler tool-part observation, and the
  SCHEDULER_VIEW_SIDEBAR_REFRESH_INTERVAL tick (scheduler-view R4).
Code impact: new feature plugin under `packages/tui/src/feature-plugins/`
  registered in `builtins.ts`; interval timer cleared through the plugin
  lifecycle disposal callback (scheduler-view I5). This entry is deleted in the
  commit that lands the plugin with its tests.
Tests: plugin tests per scheduler-view T4 (render, refresh triggers, timer
  cleanup, fetch degradation).
Review focus: no backend imports — SDK client only; timer cleared on disposal;
  a failed fetch keeps the last render and never crashes the session screen.
