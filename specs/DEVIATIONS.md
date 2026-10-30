# Specification Deviations

## D1. Gate suppression of scheduler fires writes no diagnostic record in code

- Date: `2026-10-30`
- Spec: scheduler (R6.19, with the reference from R6.13; Configuration SCHEDULER_GATE_SPAWN_FAILURE_EXIT_CODE, SCHEDULER_SUPPRESSION_LOG_LEVEL, SCHEDULER_SUPPRESSION_LOG_MARKER; T6.16, T6.17)
- Spec edit: every scheduler/suppressed-fire now writes exactly one diagnostic log record of the host process at level SCHEDULER_SUPPRESSION_LOG_LEVEL carrying the schedule id, the exit status of its scheduler/gate-run, and the marker SCHEDULER_SUPPRESSION_LOG_MARKER; R6.13 references the record; a run that fails to spawn resolves to SCHEDULER_GATE_SPAWN_FAILURE_EXIT_CODE, naming the spawn-failure outcome in the record.
- Was: `packages/core/src/scheduler/scheduler.ts` resolves a scheduler/gate-run in `resolveGateFire`, and a nonzero exit — spawn failure and signal death included — silently runs the finish path: no log line, no event, so a schedule suppressing every occurrence is indistinguishable in diagnostics from a schedule with no updates and from a gate command that cannot spawn.
- Now: the suppressed branch of the resolved fire writes exactly one diagnostic record with the schedule id, the gate-run exit status, and the marker at the configured level, before the finish path advances or removes the row.
- Code impact: `packages/core/src/scheduler/scheduler.ts` (the suppressed branch of the resolved gate fire); the spawn-failure substitution of `packages/core/src/scheduler/gate.ts` already resolves to the status named by SCHEDULER_GATE_SPAWN_FAILURE_EXIT_CODE.
- Tests: T6.16 and T6.17 of scheduler; no conforming test exists yet.
- Review focus: exactly one record per suppression, including the suppressed catch-up series case; the spawn-failure record carries SCHEDULER_GATE_SPAWN_FAILURE_EXIT_CODE; no delivery, retry, or advance behavior changes; the record emits from the serialized finish path, so it never duplicates and never blocks the loop.
