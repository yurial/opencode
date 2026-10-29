# Task Tool

Status: draft
Reference: tool-task
Spec source of truth for: the V1 `task` tool launch, resume, and completion contract — asynchronous launch by default with an immediate running result, the optional blocking `wait` argument, the `task_id` semantics of the status-only call, the live-run extension, and the continuation of a settled or interrupted run over the durable task-run registry, completion delivery into the parent session as exactly one synthetic user message through the ordinary prompt admission of the host's single runtime graph, the read-only `task_status` tool, and the session-scoped HTTP surfaces for run status and continuation.

## Overview

The `task` tool delegates work to a subagent session. This spec fixes the launch modes, the resume semantics, and the completion-delivery contract: a launch returns immediately with a running result identifying the run and promising a completion message; when the run settles, the parent session receives exactly one synthetic user message carrying the outcome. Blocking settlement remains available through an explicit argument.

A `task_id` addresses an existing subagent-run. Without a prompt the call reads status: it returns a snapshot and performs no action. With a prompt the call writes work into the run: a live job receives the prompt as additional input, and a run without a live job — settled, paused, or interrupted by a restart — receives the prompt as a continuation of its durable conversation, with prior exchange history in context. A fresh run is a launch without `task_id`.

Every launch and every continuation is recorded in the tool-task/task-run-registry, a durable table that survives process restarts. The stored row carries the last written state; the liveness of a run comes from the tool-task/live-job-registry of the host process, and a row stored `running` whose run has no live job reads as tool-task/interrupted-run, derived at read time without mutation. Completion messages never cross process-lifetime boundaries: a run whose host process died before settlement delivers no completion message, and its row keeps reading interrupted.

Completion delivery presupposes the process topology of the host: the synthetic message must reach the runtime services that own the parent session's prompt admission. The scheduler spec fixes that topology property for fire deliveries — all schedule mutations and fire deliveries of one process serialize through the single delivery loop of the scheduler service (scheduler R8.3) — and this spec introduces no second delivery path.

## Scope

In:

- Launch modes: the asynchronous default with its immediate running result, and the `wait` argument requesting blocking settlement.
- The result grammar of a launch result and of a blocking settlement result.
- The `task_id` semantics: the status-only call, the live-run extension, and the continuation of a run with no live job.
- The completion message: its grammar, its synthetic admission into the parent session, and exactly-once delivery per settled run.
- The process-topology precondition of completion delivery, citing the single-delivery-loop property of scheduler R8.3.
- The durable task-run registry: the task_run table, its columns, its writes at launch, settle, and cancel, restart survival, and the derived interrupted reading.
- The `task_status` read-only tool: its list and detail forms and its result grammar.
- The session-scoped HTTP endpoints for run status and continuation.
- The model-facing description contract of both tools.

Out (non-goals):

- Tool registration mechanics, the `task` permission ask and its pattern sets, subagent-depth enforcement, and the child session permission derivation (core-tools-permissions, config-agents).
- The subagent prompt template and the agent catalog.
- The execution machinery of live jobs — scheduling, fibers, cancellation propagation: it stays in process memory; this spec fixes only the registry writes and the liveness reading of the durable rows.
- Automatic resumption of interrupted runs: a restart never resumes execution by itself; further work on an interrupted run requires an explicit status or continuation call.
- The transcript and history of a subagent session (core-session).
- The scheduler tool and its fires (scheduler); the V2 tool execution model (v2-tools).

## Definitions

- **tool-task/subagent-run**: one execution of a subagent session launched through the task tool, identified by its child session id (the run id, the `task_id` handle of status and continuation calls).
- **tool-task/blocking-wait**: the `wait` argument value `true`, requesting that a launch return only after its subagent-run settles.
- **tool-task/completion-message**: the synthetic user message a settled subagent-run delivers into the parent session, following the completion grammar of the Interface section.
- **tool-task/task-run-registry**: the durable registry of subagent-runs — the `task_run` rows of the host database, one row per subagent-run, surviving process restarts.
- **tool-task/live-job-registry**: the process-memory registry of live subagent-run jobs of one host process; the sole source of a live run's status.
- **tool-task/live-run-extension**: a task tool call carrying `task_id` and a prompt whose addressed subagent-run has a live job; the prompt is delivered to the live run as additional input without starting a new run.
- **tool-task/continuation**: a task tool call carrying `task_id` and a prompt whose addressed subagent-run has no live job; the prompt is admitted into the durable subagent session as the next message of its conversation.
- **tool-task/interrupted-run**: the derived reading of a task-run-registry row stored `running` whose run has no live job in the live-job-registry of the reading process; derived at read time and never written.
- **tool-task/status-snapshot**: the read-only description of one subagent-run — its run id, description, stored or derived state, and timestamps — following the status snapshot grammar of the Interface section.
- **tool-task/task-run-entry**: one element of the status endpoint responses — the id, description, stored or derived state, and timestamps of one subagent-run.

## Interface

### Tool arguments

| Argument | Allowed values | Meaning |
|---|---|---|
| `wait` | optional boolean, default `false` | `true` requests blocking settlement of the launched run (R1.3); the default launches asynchronously (R1.1) |
| `task_id` | optional run id of a prior subagent-run | addresses an existing subagent-run of the calling session: without `prompt`, a status-only call (R1.5); with `prompt`, a live-run-extension or a continuation (R1.6, R1.7) |
| `prompt` | optional string when `task_id` is present, required otherwise | the launch prompt of a fresh run, or the message delivered to the addressed run |

The remaining launch arguments (`description`, `subagent_type`, `command`) and the permission gating stay with the core-tools-permissions tool contract; a call carrying `task_id` requires none of them. The former experimental `background` argument is removed: immediate return with a running result and completion by notification are the default behavior.

A `task_id` resolves for the calling session when the task-run-registry holds a row whose `id` equals it and whose `parent_session` is the calling session; any other `task_id` value fails the call with `task-not-found` (R1.8).

Error results of this spec (the complete set; semantics in Error handling):

| Error result | Meaning |
|---|---|
| `task-not-found` | `task_id` resolves to no subagent-run of the calling session (R1.8) |

### Result grammar

```
<task id="<run id>" state="running|completed|error">
[<summary>...</summary>]
<task_result>...</task_result> | <task_error>...</task_error>
</task>
```

- A launch result carries `state="running"`, the run id, and text stating that completion will arrive as a separate session message.
- A live-run-extension result and a continuation result carry the same running state and run id, with text stating that the prompt was delivered to the run.
- A blocking-wait result carries the settled state, the run id, and the final output text (`task_result`) or the failure text (`task_error`).
- The completion message body follows the same grammar with the settled state, a summary naming the run, and the final or failure text.

### Status snapshot grammar

```
<task id="<run id>" state="running|completed|error|cancelled|interrupted" description="<description>">
launched <created-at>[, settled <settled-at>]
</task>
```

- `<state>` is the stored registry state, or `interrupted` for a row stored `running` whose run has no live job (R4.11); a run with a live job reads `running` (R4.10).
- `<created-at>` and `<settled-at>` are UTC `ISO 8601` instants; the settled fragment appears only on a row whose state left `running`.
- A status list renders one status snapshot block per subagent-run, each block carrying the run id, the state, and the description (R5.2).

### Description contract

The task tool description states that launches run asynchronously by default and return immediately with a running result, that completion arrives as a separate session message, that a launch needing the result before continuing passes `wait`, and the `task_id` semantics: without `prompt` a call reads status, with `prompt` it extends a live run or continues a run with no live job (R3.1, R3.2). The task_status tool description states its read-only role and its list and detail forms (R3.3).

### task_status tool

The `task_status` tool is a read-only V1 built-in under the V1 tool contract of core-tools-permissions: it asks no permission and mutates no registry row (R5.1). Without arguments it lists the subagent-runs of the calling session; with `task_id` it returns the status snapshot of one addressed run (R5.2, R5.3).

| Argument | Allowed values | Meaning |
|---|---|---|
| `task_id` | optional run id | selects the detail snapshot of one subagent-run of the calling session |

### Task-run record

Persisted row and the source of every status surface:

| Field | Type | Meaning |
|---|---|---|
| `id` | run id | unique row id — the run id, equal to the child session id (R4.2) |
| `parent_session` | session id | the parent session of the launch |
| `child_session` | session id | the subagent session the run executes |
| `description` | string | the launch description |
| `state` | enum `running`, `completed`, `error`, `cancelled` | the stored registry state, last write wins |
| `created_at` | timestamp | the launch time |
| `updated_at` | timestamp | the last write time |
| `settled_at` | nullable timestamp | the settle or cancel time, set when the state leaves `running` |

A subagent session has at most one row; `id` and `child_session` carry the same value because the run identity of this spec is the child session id (R4.2). A continuation re-marks the row running (R4.4); the row records no per-continuation history — the durable subagent session is the history.

### HTTP endpoints

The status endpoints and the continuation mirror follow the group conventions of server-api-sdk: endpoints of the `server.session` group, paths under `/api/session/:sessionID/task`, Location resolved from the session row through the session-location middleware, success bodies in the data envelope of session routes, and no location query.

- `GET /api/session/:sessionID/task` — endpoint id `session.task.list`, OpenAPI identifier `v2.session.task.list`; returns one task-run entry per subagent-run of the path session (R5.5).
- `GET /api/session/:sessionID/task/:taskID` — endpoint id `session.task.get`, OpenAPI identifier `v2.session.task.get`; returns the task-run entry of the path task id (R5.6).
- `POST /api/session/:sessionID/task/:taskID/continue` — endpoint id `session.task.continue`, OpenAPI identifier `v2.session.task.continue`; payload `{"message": string}`; applies the liveness decision tree of the task tool continuation and returns the resulting running entry (R5.7).

Task-run entry fields: `id` — string, the run id; `description` — string; `state` — string, the stored state or the derived `interrupted` (R5.4); `createdAt` and `updatedAt` — integers, UTC epoch milliseconds; `settledAt` — integer or null.

Success bodies:

```json
{"data":{"tasks":[{"id":"ses_run","description":"fix tests","state":"running","createdAt":1792937100000,"updatedAt":1792937100000,"settledAt":null}]}}
```

The continue endpoint returns the same entry shape for one run under the `task` key, with `state` `running`.

Error results (the complete set; semantics in Error handling):

| Error result | HTTP status |
|---|---|
| `InvalidRequestError` | HTTP `400` |
| `UnauthorizedError` | HTTP `401` |
| `SessionNotFoundError` | HTTP `404` |
| `TaskNotFoundError` | HTTP `404` |
| `UnknownError` | HTTP `500` |

## Requirements

- R1. Launch and address modes:
- R1.1. verification=automated; A launch without `wait` starts its subagent-run and returns a tool result without waiting for the run's settlement.
- R1.2. verification=automated; An asynchronous launch result carries the run id and the running state and states that completion will arrive as a separate session message.
- R1.3. verification=automated; A launch with `wait` of `true` returns only after its subagent-run settles, carrying the run's final output on completion or the run's failure text on error.
- R1.4. verification=automated; Asynchronous launch is the default path of the tool, and no experimental flag gates it.
- R1.5. verification=automated; A task tool call carrying `task_id` without `prompt` performs no launch, no continuation, and no registry write, asks no permission, and returns the status snapshot of the addressed subagent-run.
- R1.6. verification=automated; A task tool call carrying `task_id` and `prompt` whose addressed subagent-run has a live job delivers the prompt to the live run as additional input, starts no new run, and returns the running result.
- R1.7. verification=automated; A task tool call carrying `task_id` and `prompt` whose addressed subagent-run has no live job admits the prompt into the durable subagent session as the next message of its conversation, with prior exchange history in context, and returns the running result.
- R1.8. verification=automated; A task tool call whose `task_id` resolves to no subagent-run of the calling session fails with `task-not-found` and performs no action.
- R2. Completion delivery:
- R2.1. verification=automated; When an asynchronously launched subagent-run settles, the parent session receives exactly one synthetic user message following the completion grammar, carrying the run id and the settled state.
- R2.2. verification=automated; The completion message is admitted through the ordinary prompt admission path of the parent session's runtime.
- R2.3. verification=scenario; Completion delivery rides the single runtime service graph of the host process — the process-global serialization property fixed by scheduler R8.3 for fire deliveries — and the task tool defines no second delivery path.
- R2.4. verification=automated; A live-run-extension or a continuation keeps the completion contract of the original launch: when the extended or continued work settles, the parent session receives exactly one completion message carrying the same run id and the settled state.
- R2.5. verification=automated; A cancelled subagent-run delivers no completion message.
- R3. Model-facing contract:
- R3.1. verification=automated; The task tool description documents the asynchronous default, the completion notification, and the `wait` argument.
- R3.2. verification=automated; The task tool description documents the `task_id` semantics: the status-only call without `prompt`, the extension of a live run, and the continuation of a run with no live job.
- R3.3. verification=automated; The task_status tool description documents its read-only role and its list and detail forms.
- R4. Durable run registry:
- R4.1. verification=automated; Subagent-run registry state persists in the task_run table with snake_case columns under the table-ownership rules of storage-events.
- R4.2. verification=automated; A subagent session has at most one task_run row, and the row `id` equals the child session id — the run id of a subagent-run.
- R4.3. verification=automated; A launch inserts the row of its subagent-run with the stored state `running` at launch time.
- R4.4. verification=automated; A continuation re-marks the row of its subagent-run `running` before the continuation prompt is admitted.
- R4.5. verification=automated; A settle updates the stored state of the row to `completed` or `error` and records the settle time.
- R4.6. verification=automated; A cancel updates the stored state of the row to `cancelled` and records the settle time.
- R4.7. verification=automated; Task-run rows survive a process restart.
- R4.8. verification=automated; Deleting the subagent session row deletes its task_run row through the cascading foreign key.
- R4.9. verification=automated; The task_run table registers through the generated migration pipeline of storage-events.
- R4.10. verification=automated; The status of a subagent-run with a live job reads as `running` on every status surface, taken from the live-job-registry of the host process rather than the stored row.
- R4.11. verification=automated; A stored `running` state of a row whose run has no live job in the live-job-registry reads as the `interrupted` state, derived at read time; the read mutates no row.
- R4.12. verification=scenario; Completion messages are not delivered across process-lifetime boundaries: a run whose host process died before settlement delivers no completion message, and its row keeps reading `interrupted`.
- R5. Status surfaces:
- R5.1. verification=automated; The task_status tool is a read-only V1 built-in that asks no permission and mutates no registry row.
- R5.2. verification=automated; A task_status call without `task_id` returns one status snapshot block per subagent-run of the calling session, each block carrying the run id, the state, and the description, newest launch first, ties ordered by run id ascending.
- R5.3. verification=automated; A task_status call with `task_id` returns the status snapshot of the addressed subagent-run of the calling session; a `task_id` resolving to no subagent-run of the calling session fails the call with `task-not-found`.
- R5.4. verification=automated; Every status surface — the task tool status call, the task_status tool, and the status endpoints — reports a run with a live job as `running` and a stored `running` row without a live job as `interrupted`.
- R5.5. verification=automated; The session.task.list endpoint answers read-only GET requests with one task-run entry per subagent-run of the path session, mutating no registry row and performing no permission ask.
- R5.6. verification=automated; The session.task.get endpoint answers a read-only GET request with the task-run entry of the path task id, mutating no registry row and performing no permission ask.
- R5.7. verification=automated; The session.task.continue endpoint carries a message payload, resolves the addressed subagent-run of the path session, and applies the same liveness decision tree as the task tool: a live job extends the run, no live job admits a continuation, and the response returns the resulting running entry.
- R5.8. verification=automated; The completion message of work started through the continue endpoint is delivered into the parent session named by the path, under the same completion contract as a tool continuation.
- R5.9. verification=automated; The continue endpoint performs no permission ask; its authorization is the server authorization of the HTTP stack.
- R5.10. verification=automated; A request whose path session id resolves to no stored session fails with `SessionNotFoundError`.
- R5.11. verification=automated; A request whose path session id or path task id fails to decode fails with `InvalidRequestError`.
- R5.12. verification=automated; A request whose path task id resolves to no subagent-run of the path session fails with `TaskNotFoundError`.

## Implementation

- I1. The existing background mechanism becomes the main path: the job start, the completion watcher, and the synthetic injection of the completion message (`packages/opencode/src/tool/task.ts`); the blocking branch keeps its acquire-use-release wait as the implementation of `wait`.
- I2. The `background` argument, its experimental flag, and its description gating are removed; the background guidance text merges into the base description per R3.1.
- I3. The completion message renders through the same result grammar as a blocking result, so the model reads one shape on both paths.
- I4. Registry writes live in the task tool paths: the launch inserts the row, the completion watcher writes the settle state before admitting the completion message, the cancel path writes `cancelled`, and the continuation branch re-marks `running` before the prompt is admitted (`packages/opencode/src/tool/task.ts`).
- I5. Liveness reads from the existing background job registry of the host process keyed by session id (`packages/opencode/src/background/job.ts`); the derived `interrupted` state is computed at read time, and no background job mutates rows.
- I6. The continuation branch reuses the ordinary prompt admission path of the subagent session — the same prompt ops as the launch — after the parent-binding check against the task_run row.
- I7. The task_status tool registers as a read-only V1 built-in beside the task tool, with no ask in its execute path.
- I8. The endpoints live in the `server.session` protocol group with the session-location middleware; adding them is a wire-schema change requiring the private client generation and the legacy SDK build to run, plus a `TaskNotFoundError` public error.
- I9. The task_run table lives with the core storage tables, carries a cascading foreign key to the session table on `child_session`, and an index on `parent_session` for the session-scoped lists.

## Examples

- E1. Launch and address modes:
- E1.1. A launch of `description: "fix tests"` with a registered subagent type and no `wait` returns immediately, carrying `state="running"`, the run id, and the notification promise; the parent model continues other work.
- E1.3. The same launch with `wait: true` returns after the run settles, carrying the final output text, or the failure text when the run errors.
- E1.5. After E1.1, a call carrying its `task_id` and no `prompt` returns the snapshot of that run — `state="running"` with the launch instant — starts nothing, and asks nothing.
- E1.6. While the run of E1.1 is live, a call carrying its `task_id` and `prompt: "also run the linter"` returns the running result for the same run id, and no new run starts.
- E1.7. After the run of E1.1 settles, a call carrying its `task_id` and `prompt: "extend the fix to the sister module"` admits the prompt into the same subagent session with the earlier exchange in context, re-marks the registry row `running`, and returns the running result.
- E1.8. A call carrying the `task_id` of another session's run fails with `task-not-found` and performs nothing.
- E2. Completion delivery:
- E2.1. The run of E1.1 settling with a summary delivers exactly one synthetic user message with `state="completed"` and the final text into the parent session, and nothing else is delivered for that run.
- E2.4. The continuation of E1.7 settling with a summary delivers exactly one completion message with the same run id and `state="completed"`, and nothing else is delivered for that settlement.
- E2.5. A run cancelled by its parent delivers no completion message; its registry row reads `cancelled`.
- E3. Model-facing contract:
- E3.2. The task tool description names the `task_id` forms, so the model knows the status-only call carries no `prompt` and the continuation carries one.
- E4. Durable run registry:
- E4.2. The launch of E1.1 inserts one row with `id` equal to the child session id and state `running`; the launch of a second subagent inserts its own row.
- E4.5. When the run of E1.1 settles, its row state becomes `completed` and the settle time is recorded.
- E4.7. After a process restart, the row of a run that was live at shutdown still exists and reads `interrupted`, and no completion message for it is ever delivered.
- E4.11. Reading the status of the interrupted run of E4.7 twice returns `interrupted` both times and mutates no row.
- E5. Status surfaces:
- E5.2. A task_status call of the parent session lists its runs newest first, one status snapshot block per run, each block carrying the run id, the state, and the description.
- E5.3. A task_status call with the `task_id` of E1.1 returns the snapshot of that run; with the `task_id` of another session's run it fails with `task-not-found`.
- E5.4. A run with a live job reads `running` on the task tool status call, task_status, and both status endpoints; a stored `running` row without a live job reads `interrupted` on each of them.
- E5.7. A continue request against a live run extends it and returns the running entry; against a settled run it continues the conversation and returns the running entry.

## Tests

- T1. Launch and address modes:
- T1.1. R-ID=R1.1, R1.4; procedure=task tool launch test with no flags and no `wait`; conditions=a registered subagent type; expected=the tool result returns before the run settles, carrying the running state, with no experimental flag set.
- T1.2. R-ID=R1.2; procedure=launch result content test; conditions=an asynchronous launch; expected=the result follows the result grammar with the run id and `state="running"` and states that completion will arrive as a separate session message.
- T1.3. R-ID=R1.3; procedure=blocking launch test with `wait: true`; conditions=a run that settles successfully and a run that errors; expected=the result carries the final output text or the failure text, and only after settlement.
- T1.5. R-ID=R1.5; procedure=status-only call test; conditions=a call carrying the `task_id` of an existing run and no `prompt`; expected=the call returns the status snapshot of that run and performs no launch, no continuation, no registry write, and no permission ask.
- T1.6. R-ID=R1.6; procedure=live-extension test; conditions=a call carrying `task_id` and `prompt` while the run's job is live; expected=the prompt reaches the live run, no new run starts, and the result is the running result for the same run id.
- T1.7. R-ID=R1.7; procedure=continuation test after settlement; conditions=a call carrying `task_id` and `prompt` against a settled run; expected=the prompt is admitted into the same subagent session with prior history in context and the result is the running result for the same run id.
- T1.8. R-ID=R1.8; procedure=unknown and foreign `task_id` test; conditions=calls carrying a `task_id` of no run and a `task_id` of another session's run; expected=both fail with `task-not-found` and perform no action.
- T2. Completion delivery:
- T2.1. R-ID=R2.1, R2.2; procedure=completion delivery test; conditions=an asynchronously launched run settling while the parent session is idle; expected=exactly one synthetic user message following the completion grammar appears in the parent session through the ordinary prompt admission path.
- T2.3. R-ID=R2.3; procedure=host-topology scenario against one host process serving the parent session through a single runtime graph; conditions=an asynchronously launched run settling; expected=the completion message reaches the owning runner and drives the parent's next turn, with no second delivery path involved.
- T2.4. R-ID=R2.4; procedure=continuation completion test; conditions=a continued run settling while the parent session is idle; expected=exactly one completion message with the same run id and the settled state arrives through the ordinary prompt admission path.
- T2.5. R-ID=R2.5; procedure=cancel delivery test; conditions=a run cancelled before settlement; expected=no completion message is delivered and the registry row reads `cancelled`.
- T3. Model-facing contract:
- T3.1. R-ID=R3.1; procedure=description content check at registry build; conditions=the composed tool description; expected=it names the asynchronous default, the completion notification, and the `wait` argument.
- T3.2. R-ID=R3.2; procedure=description content check at registry build; conditions=the composed task tool description; expected=it names the status-only call, the live-run extension, and the continuation.
- T3.3. R-ID=R3.3; procedure=description content check of task_status; conditions=the composed task_status description; expected=it names the read-only role and the list and detail forms.
- T4. Durable run registry:
- T4.1. R-ID=R4.1, R4.2; procedure=table and row-uniqueness test; conditions=launches of two subagent-runs and a continuation of one of them; expected=the task_run table holds snake_case columns and exactly one row per subagent session, its `id` equal to the child session id.
- T4.2. R-ID=R4.3; procedure=launch-insert test; conditions=an asynchronous launch; expected=the row is inserted with state `running` and the launch time.
- T4.3. R-ID=R4.4; procedure=continuation re-mark test; conditions=a continuation of a settled run; expected=the row state returns to `running` before the prompt is admitted.
- T4.4. R-ID=R4.5, R4.6; procedure=settle and cancel write test; conditions=runs that complete, error, and are cancelled; expected=the states become `completed` and `error` with the settle time recorded, and `cancelled` with the settle time recorded.
- T4.5. R-ID=R4.7; procedure=restart survival test; conditions=a database reopen after launches and settles; expected=every task_run row persists with its state.
- T4.6. R-ID=R4.8; procedure=cascade test; conditions=deletion of the subagent session row; expected=its task_run row is deleted.
- T4.7. R-ID=R4.9; procedure=migration registration test; conditions=a fresh database and the migration pipeline check; expected=the task_run table registers through the generated migration pipeline.
- T4.8. R-ID=R4.10; procedure=live-status source test; conditions=a run with a live job; expected=every status surface reports `running` from the live-job-registry.
- T4.9. R-ID=R4.11; procedure=derived interrupted test; conditions=a stored `running` row whose run has no live job; expected=the status reads `interrupted` and the row is unchanged after the read.
- T4.10. R-ID=R4.12; procedure=cross-boundary delivery scenario; conditions=a run live at process death, then a process restart; expected=no completion message is ever delivered for it and its row keeps reading `interrupted`.
- T5. Status surfaces:
- T5.1. R-ID=R5.1; procedure=task_status read-only test; conditions=a task_status call of a session with runs; expected=no permission ask occurs and no registry row changes.
- T5.2. R-ID=R5.2; procedure=list form test; conditions=a session with runs launched at distinct times and two launched together; expected=one status snapshot block per run, newest first, the tie ordered by run id ascending.
- T5.3. R-ID=R5.3; procedure=detail form test; conditions=a task_status call with the `task_id` of a run of the calling session and one of another session's run; expected=the first returns the snapshot, the second fails with `task-not-found`.
- T5.4. R-ID=R5.4; procedure=derived-state reporting test; conditions=one run with a live job and one stored `running` row without a live job; expected=the first reads `running` and the second `interrupted` on the task tool status call, task_status, and both status endpoints.
- T5.5. R-ID=R5.5; procedure=session.task.list endpoint test; conditions=a GET against a session with runs; expected=one task-run entry per run in the data envelope, with no registry mutation and no permission ask.
- T5.6. R-ID=R5.6; procedure=session.task.get endpoint test; conditions=a GET with the task id of a run of the path session; expected=the entry returns in the data envelope, with no registry mutation and no permission ask.
- T5.7. R-ID=R5.7; procedure=session.task.continue endpoint test; conditions=a POST with a message against a live run and against a settled run; expected=the live run is extended and the settled run is continued, and the response is the running entry.
- T5.8. R-ID=R5.8; procedure=continue completion test; conditions=continued work started through the endpoint settling; expected=exactly one completion message arrives in the parent session named by the path.
- T5.9. R-ID=R5.9; procedure=continue authorization test; conditions=a POST against an authorized server; expected=no permission ask occurs and the request passes only the server authorization.
- T5.10. R-ID=R5.10; procedure=unknown-session request test; conditions=a path session id resolving to no stored session; expected=the request fails with `SessionNotFoundError`.
- T5.11. R-ID=R5.11; procedure=undecodable-id request test; conditions=a path session id or task id that fails to decode; expected=the request fails with `InvalidRequestError`.
- T5.12. R-ID=R5.12; procedure=unknown-task request test; conditions=a path task id resolving to no subagent-run of the path session; expected=the request fails with `TaskNotFoundError`.

## Justification

- J1. Why asynchronous by default (R1.1, R1.4): a blocking default parks the parent model behind each subagent and invites duplicate work whenever history serialization misrepresents a live call as interrupted; an immediate running result with a promised completion message keeps the parent productive and honest about the run's liveness.
- J2. Why completion rides the ordinary prompt admission of the single runtime graph (R2.2, R2.3): a delivery path outside the owning runner reproduces the double-delivery divergence class that the scheduler single-delivery-loop property (scheduler R8.3) exists to prevent.
- J3. Why `wait` instead of the former `background` (Interface): the default inverted, so the opt-in names the exceptional mode — blocking — and the description stops advertising an argument whose former meaning is the default.
- J4. Why the run registry is durable (R4.1-R4.7): a status surface on process memory alone reports every restarted run as vanished and invites duplicate launches; one durable row per run carries the last known fact across restarts at constant storage cost.
- J5. Why the interrupted reading is derived instead of written at startup (R4.11): the process cannot observe the outcome of a run that died with its predecessor, and a startup write would assert a fact nobody saw while racing an immediate continuation; deriving at read keeps registry writes to observed transitions only.
- J6. Why completion messages never cross process-lifetime boundaries (R4.12): the completion watcher lives in the process that owns the live job; after its death the settlement is unknowable, and startup replay would deliver messages for work that never settled — status plus continuation is the honest recovery path.
- J7. Why a continuation admits into the same durable session instead of starting a fresh run (R1.7, R2.4): the subagent conversation is the durable unit of work; continuing it preserves grounding and prior context, while a fresh start stays an explicit launch without `task_id`.
- J8. Why a separate task_status tool instead of a status mode of the task tool (R5.1): the launch tool keeps an unconditional launch schema and its side-effect permission ask, while a status read asks nothing and mutates nothing — one tool, one posture — and the task description stays launch-focused.
- J9. Why the run id equals the child session id (R4.2): one durable handle for the model — the id of every result, snapshot, and endpoint is the id valid as `task_id`; a second per-activation identifier would invite conflation with the session handle.
- J10. Why the continue endpoint mirrors the tool decision tree (R5.7): one liveness decision tree serves both surfaces; a divergent HTTP path could create work the tool cannot address or bypass the registry writes.

## Error handling

- All error results of the tool are final results of a failed tool call; the tool retries nothing itself, and the model may re-call with corrected arguments.
- `task-not-found` names a `task_id` that resolves to no subagent-run of the calling session — unknown, foreign, or deleted; the call performed nothing (R1.8).
- The interrupted reading is not an error: a derived `interrupted` status is a normal snapshot of a run whose host process died before settlement (R4.11, R4.12).
- A cancelled subagent-run delivers no completion message (R2.5); the surface that cancelled it already knows.
- A crash between the settle write and the completion admission can leave a settled row whose message was never delivered; the row keeps the fact, and the loss degrades at most one notification. This window is an accepted risk.
- HTTP errors follow the public error conventions of server-api-sdk: `InvalidRequestError` for undecodable path ids (R5.11), `SessionNotFoundError` for an unknown session (R5.10), `TaskNotFoundError` for an unknown or foreign task id (R5.12), `UnauthorizedError` when the server auth rejects the request, and `UnknownError` for unexpected defects after logging.
- A completion admission failure is swallowed by the watcher and diagnosable through the log; it fails no tool call and retries nothing.

## Usage constraints

- Adding the session.task.list, session.task.get, and session.task.continue endpoints is a wire-schema change of the public HttpApi: the private client generation and the legacy SDK build must both run after the protocol change, and the change is recorded in the v2 schema change ledger when that ledger is next updated.

## Dependencies

- core-tools-permissions — the task and task_status tools are V1 built-ins under its tool contract, registry, and `task` permission ask; this spec changes the launch, resume, and completion behavior and adds the status surfaces.
- core-session — the completion message and the continuation prompt are admitted through the V1 prompt boundary it documents; the subagent session transcript is its durable history.
- scheduler — the completion-delivery topology precondition cites its single-delivery-loop property (R8.3); no scheduler behavior changes here.
- storage-events — the task_run table follows its table-ownership and column conventions (R11, R12, R14) and registers through its generated migration pipeline (R10).
