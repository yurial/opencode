# Specification Deviations

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
