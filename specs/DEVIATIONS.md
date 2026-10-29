# Specification Deviations

## D1. task_list tool absent; the list mode still lives on task_status

- Date: `2026-10-29`
- Spec: tool-task (R6.1, R6.2; Interface "task_list tool"; R5.1, R5.3 detail-only task_status)
- Spec edit: the argumentless list form moved from the task_status tool to a dedicated read-only task_list tool; task_status became detail-only with a required `task_id`.
- Was: no task_list tool exists; `packages/opencode/src/tool/task-status.ts` answers the argumentless call with the newest-first list, and its schema keeps `task_id` optional.
- Now: a task_list V1 built-in takes no arguments, asks no permission, mutates no row, and returns one status snapshot block per subagent-run of the calling session, newest launch first, ties ordered by run id ascending (R6.1, R6.2); task_status requires `task_id` and returns the snapshot of one addressed run (R5.1, R5.3).
- Code impact: register the task_list built-in beside task_status, move the list branch and its description text, and make the task_status `task_id` required.
- Tests: T6.1, T6.2 for the new tool; T5.3 and T3.3 must hold under the required `task_id`; T3.4 covers the new description.
- Review focus: no permission ask in the list path; newest-first ordering with the run id tiebreak; task_status rejects an argumentless call; no registry mutation from either tool.

## D2. task_abort tool absent

- Date: `2026-10-29`
- Spec: tool-task (R7.1–R7.6; Interface "task_abort tool")
- Spec edit: new task_abort control tool stopping an addressed subagent-run with a three-state liveness decision tree and no permission ask.
- Was: no tool stops a subagent-run; a parent can only abandon a run — after a restart its row keeps reading `interrupted` — and only the parent tool-call abort path cancels a blocking run from the parent side.
- Now: a task_abort call cancels a live job together with the child session's in-flight work and records the cancel with its settle time (R7.2, R4.6); a stored `running` row without a live job is re-marked `cancelled` (R7.3); a settled run is confirmed as an idempotent no-op (R7.4); an unknown or foreign `task_id` fails with `task-not-found` (R7.5); no completion message is delivered (R2.5).
- Code impact: register the task_abort built-in composing the registry cancel write, the background job cancel, and the abort of the child session's work; add the interrupted re-mark and the settled no-op branches; no permission ask in the execute path.
- Tests: T7.1–T7.6.
- Review focus: no completion message after a stop; the cancel write records the settle time; the interrupted re-mark is the only task_abort write on a row without a live job; the settled branch writes nothing; the abort surface asks no permission.
