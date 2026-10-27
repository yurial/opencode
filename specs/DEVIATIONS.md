# Specification Deviations

## D1 — scheduler-view sidebar eta re-render tick

- Date: `2026-10-27`
- Spec: scheduler-view (specs/scheduler-view.md)
- Spec edit: leaf requirements R4.15–R4.17 added with the Configuration constant SCHEDULER_VIEW_SIDEBAR_ETA_TICK_INTERVAL
- Was: The sidebar block re-renders the eta text of its entry lines only inside a refetch re-render — on the first mount, a change of the current session, a newly observed scheduler tool part, and every periodic refetch; between those triggers the rendered eta text goes stale.
- Now: Every expiry of SCHEDULER_VIEW_SIDEBAR_ETA_TICK_INTERVAL re-renders the scheduler-view/eta of every rendered entry line from the eta-clock of the TUI process with no fetch, and the eta-tick interval timer clears on disposal (R4.15–R4.17).
- Code impact: packages/tui/src/feature-plugins/sidebar/scheduler.tsx — the View needs a periodic eta re-render driven by the eta-clock (an interval timer or an equivalent reactive clock reading) with cleanup on unmount and on the TUI plugin lifecycle disposal; the tick path must issue no SDK client request.
- Tests: T4.14–T4.16 specify the checks; the code tests land with the implementation.
- Review focus: the tick path issues no schedule-list request; the re-render derives only from the eta-clock and the entries of the last successful response; the eta-tick timer clears on disposal together with the refetch timer; the refetch triggers of R4.8–R4.10 stand unchanged.
