# Specification Deviations

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
