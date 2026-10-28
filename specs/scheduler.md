# Scheduler Tool

Status: stable
Reference: scheduler
Spec source of truth for: the AI-facing scheduler — the `scheduler` tool (actions add, remove, list), session-bound persisted schedules, the interval, cron, and one-shot time-spec inputs, the optional scheduler/gate-command checked before each fire, fire delivery into sessions served by the V2 and the V1 runtime, missed-fire catch-up, permission gating, and the process-global scheduler service with its single delivery loop.

## Overview

The scheduler lets the model running inside a session schedule future events for itself. A scheduler/schedule carries a firing rule, a message text, and an optional scheduler/gate-command; at each due time the scheduler/service first runs the stored gate command when one exists, and delivers a scheduler/fired-message into the owning session when the run exits with status zero, so the model sees it and continues work (R6). A nonzero exit status suppresses the fire: the event the command checks has not occurred (R6.13, R6.15, R6.16). Schedules are created and managed through the `scheduler` tool (R1), are bound to the creating session (R2), and persist in the schedule table across process restarts (R4). Adding and removing asks the `scheduler` permission through the V1 ask flow (R5); firing itself is not a tool call and asks nothing, the gate command included (R5.4, R5.5).

The scheduler core ships no HTTP surface of its own: no protocol group, no handler, and no SDK regeneration belong to it. The one exception is the read-only schedule-list endpoint, owned by scheduler-view, which reads scheduler/schedule rows through the scheduler/service as its data source.

Fired messages are transient nudges, not durable state. The schedule row is the durable artifact; a fired message displaced from visible history by a later epoch replacement or compaction is never re-delivered (R9). History filtering of discarded assistant and user parts never touches a fired system message, because system messages are not eligible filtering parts. Schedule state lives in a table, not in the event log, so event-log pruning never removes a schedule.

## Scope

In:

- The `scheduler` tool surface: actions add, remove, list; argument domains; success and error result contracts.
- Schedule spec inputs: interval (`every`), cron expression (`cron`), one-shot datetime or scheduler/relative-at (`at`); conversion, validation, and storage rules.
- The optional scheduler/gate-command of a scheduler/schedule: the `command` argument, validation, execution before each fire, suppression of fires, catch-up interplay, and the scheduler/gate-output-section.
- Session binding of schedules and cascade removal on session deletion.
- Fire delivery into sessions served by the V2 runtime and by the V1 runtime; the fired-message grammar.
- Missed-fire catch-up semantics for recurring and one-shot schedules.
- Persistence: the schedule table, its migration registration, restart survival.
- Permission gating of add and remove.
- The scheduler service: process-global layer node, init reload, single delivery loop.

Out (non-goals):

- Any HTTP surface of its own beyond the read-only schedule-list endpoint owned by scheduler-view; in particular any schedule-mutating HTTP API, protocol handler, or SDK operation.
- Schedules not bound to a session: global, cross-session, or user-facing reminders.
- Local-timezone or daylight-saving-aware recurring schedules; all due-time evaluation is UTC.
- Multi-process schedule ownership: concurrent processes writing one database, beyond the single-writer constraint the loop inherits from storage-events.
- Calendar semantics beyond standard cron: holiday skipping, natural-language dates, reminder UX.

## Definitions

- **scheduler/schedule**: a persisted record binding a firing rule, a message text, and an optional scheduler/gate-command to the session whose tool call created it; identified by a `sch_`-prefixed id.
- **scheduler/cron-spec**: the standard five-field cron expression that is the canonical stored firing rule of a recurring scheduler/schedule.
- **scheduler/one-shot**: a scheduler/schedule created from a datetime that fires exactly once at that time and is removed by its fire.
- **scheduler/relative-at**: an `at` input form consisting of the prefix `now+` followed either by a positive integer and one unit letter of SCHEDULER_RELATIVE_AT_UNITS or by the clock form of SCHEDULER_RELATIVE_AT_CLOCK_SHAPE; it names a positive offset from the current time.
- **scheduler/recurring**: a scheduler/schedule whose firing rule is a scheduler/cron-spec; it fires at every match and survives each fire until removed.
- **scheduler/next-due-time**: the stored UTC timestamp at which a scheduler/schedule is next to fire (the `next_fire_at` column).
- **scheduler/fire**: the delivery of a scheduler/schedule message into its owning session at a reached due time: the durable publish plus the prompt admission of the scheduler/fired-message.
- **scheduler/scheduled-fire-time**: the UTC time of the occurrence a scheduler/fire discharges; equal to the scheduler/next-due-time when the fire is initiated.
- **scheduler/catch-up-fire**: a scheduler/fire delivered after its scheduler/scheduled-fire-time because its scheduler/scheduled-fire-time precedes the load of the scheduler/service in the current process, or it retries a previously failed delivery, or its scheduler/scheduled-fire-time was reached while a scheduler/gate-run of the same scheduler/schedule was in flight; discharges every skipped occurrence of a scheduler/recurring schedule at once.
- **scheduler/fired-message**: the message text delivered by a scheduler/fire, following the fixed grammar of the Interface section, with the catch-up marker appended for a scheduler/catch-up-fire and the scheduler/gate-output-section appended after a permitted scheduler/gate-run wrote output.
- **scheduler/gate-command**: the optional command text stored on a scheduler/schedule through the `command` argument of its add; a scheduler/gate-run executes it before each fire of that schedule, and its exit status decides the fire.
- **scheduler/gate-run**: one execution of a scheduler/gate-command under the shell invocation of SCHEDULER_GATE_SHELL with the working directory SCHEDULER_GATE_WORKING_DIRECTORY, capturing the combined standard output and error; the exit status of the invocation is the exit status of the run, and the run's resolution time is the time its exit status is observed.
- **scheduler/gate-echo**: the single-line fragment that the add and list success results of a scheduler/schedule with a stored scheduler/gate-command append, per the gate-echo grammar of the Interface section.
- **scheduler/gate-output-section**: the section that a fire permitted by a scheduler/gate-run appends to its scheduler/fired-message when the run wrote output, per the fired-message grammar of the Interface section.
- **scheduler/suppressed-fire**: a fire whose scheduler/gate-run exited with a nonzero status; it delivers nothing and discharges its occurrence, or its entire skipped series when it is a scheduler/catch-up-fire.
- **scheduler/service**: the process-global service node that owns schedule rows and the single delivery loop of one process.

## Interface

### Tool

The `scheduler` tool is a V1 built-in under the V1 tool contract of core-tools-permissions: Effect Schema parameters, ask before side effects, registered in the V1 tool registry.

Arguments:

| Argument | Applies to | Allowed values |
|---|---|---|
| `action` | all calls | enum: `add`, `remove`, `list` |
| `message` | add | non-empty string, at most SCHEDULER_MAX_MESSAGE_LENGTH characters |
| `every` | add, optional | positive integer followed by one of the unit letters `m`, `h`, `d` (for example `30m`, `1h`, `1d`) |
| `cron` | add, optional | standard five-field cron expression |
| `at` | add, optional | ISO 8601 datetime, naive or zoned, or a scheduler/relative-at: the unit form `now+<positive integer><unit letter>` with the unit letters of SCHEDULER_RELATIVE_AT_UNITS, or the clock form `now+HH:MM:SS` with the shape and bounds of SCHEDULER_RELATIVE_AT_CLOCK_SHAPE (for example `now+5m`, `now+01:30:25`) |
| `command` | add, optional | non-empty string, at most SCHEDULER_MAX_COMMAND_LENGTH characters — the scheduler/gate-command text |
| `id` | remove | schedule id |

`every`, `cron`, and `at` are mutually exclusive; an add carries exactly one of them. The scheduler/relative-at forms are accepted only by `at` and never by `every` or `cron`. `list` takes no further arguments. `command` is independent of the spec inputs: an add may carry it with any one of them, and an add without `command` stores no scheduler/gate-command.

Success results (model-facing text):

- add: echoes the schedule id, the spec form (the stored scheduler/cron-spec, or the stored UTC datetime of a scheduler/one-shot), and the scheduler/next-due-time in UTC. An add carrying a `command` ends its result line with the scheduler/gate-echo.
- list: one line per scheduler/schedule of the calling session, each carrying the schedule id, the spec form, the scheduler/next-due-time in UTC, and the message text; no schedules yields an empty listing. A line of a scheduler/schedule with a stored scheduler/gate-command ends with the scheduler/gate-echo.
- remove: confirms the removed schedule id.

Error results (the complete set; semantics in Error handling):

| Error result | Meaning |
|---|---|
| `invalid-arguments` | args fail schema decode: wrong types, missing `id`, unknown action (R1.3) |
| `schedule-spec-conflict` | add carries zero or more than one of `every`, `cron`, `at` (R3.1) |
| `invalid-interval` | `every` is malformed (R3.2) |
| `invalid-cron` | `cron` is malformed (R3.4) |
| `cron-without-future-match` | `cron` has no future match (R3.5) |
| `invalid-at` | `at` is unparseable as an ISO 8601 datetime or a scheduler/relative-at (R3.6, R3.10) |
| `at-in-past` | `at` resolves to a time not after the current time (R3.8) |
| `message-too-long` | `message` is longer than SCHEDULER_MAX_MESSAGE_LENGTH (R3.9) |
| `command-too-long` | `command` is longer than SCHEDULER_MAX_COMMAND_LENGTH (R3.13) |
| `schedule-cap-reached` | the calling session already holds SCHEDULER_MAX_SCHEDULES_PER_SESSION schedules (R2.4) |
| `schedule-not-found` | remove names no schedule of the calling session (R2.3) |
| `permission-denied` | the permission ask was denied (R5.2) |

### Schedule record

Persisted row and list entry:

| Field | Type | Meaning |
|---|---|---|
| `id` | `sch_`-prefixed string | unique schedule id |
| `session_id` | session id | owning session |
| `cron` | nullable scheduler/cron-spec | firing rule of a scheduler/recurring schedule |
| `at` | nullable UTC timestamp, integer epoch milliseconds | due time of a scheduler/one-shot |
| `message` | string | message text delivered on fire |
| `command` | nullable string | the stored scheduler/gate-command text |
| `next_fire_at` | UTC timestamp, integer epoch milliseconds | stored scheduler/next-due-time |
| `created_at`, `updated_at` | timestamps | shared timestamp columns |

Exactly one of `cron` and `at` is non-null per row. A null `command` stores no scheduler/gate-command.

### Fired-message grammar

```
<scheduled-fire-time> fired schedule id <id> <spec>: <message><catch-up-marker><gate-output-section>
```

- `<scheduled-fire-time>`: the scheduler/scheduled-fire-time, UTC, ISO 8601.
- `<id>`: the schedule id.
- `<spec>`: the scheduler/cron-spec of a scheduler/recurring schedule, or the stored UTC datetime of a scheduler/one-shot.
- `<message>`: the stored message text.
- `<catch-up-marker>`: present only on a scheduler/catch-up-fire; the literal fixed by SCHEDULER_CATCH_UP_MARKER in Configuration.
- `<gate-output-section>`: present only on a fire whose scheduler/gate-run exited with status zero and wrote output; the literal header of SCHEDULER_GATE_OUTPUT_HEADER followed by the combined output of the run, trimmed of leading and trailing whitespace and truncated to SCHEDULER_MAX_GATE_OUTPUT_LENGTH characters with an ellipsis character appended when truncation occurs.
- A scheduler/gate-run wrote output when its combined output is non-empty after trimming leading and trailing whitespace.

### Gate echo

```
 [gate: <command>]
```

- The fragment ends the add and list success lines of a scheduler/schedule with a stored scheduler/gate-command.
- `<command>`: the stored command text with every whitespace run collapsed to a single space.
- The fragment never precedes the `next due` fragment of its line and never introduces a line break, so the first `next due` fragment of the line keeps naming its schedule.

### Permission ask

Add and remove ask through the V1 permission flow under the permission name `scheduler`; the pattern set of an add ask is the spec form, the pattern set of a remove ask is the schedule id; list asks nothing (R5). A `command` of an add joins no pattern set and asks nothing beyond the add ask.

### Delivery boundary

A fire of a session served by the V2 runtime: one `SessionEvent.ContextUpdated` durable event carrying the scheduler/fired-message with no context-epoch advance, one admitted durable input carrying the same text, and one execution wake (R6.3, R6.4). A fire of a session served by the V1 runtime: one synthetic user text part carrying the scheduler/fired-message, admitted through the V1 prompt path (R6.5).

## Configuration

| Name | Allowed values | Default | Effect |
|---|---|---|---|
| SCHEDULER_MAX_SCHEDULES_PER_SESSION | `fixed` 50 schedules | — | Per-session add cap; an add that would exceed it returns `schedule-cap-reached` (R2.4) |
| SCHEDULER_MAX_MESSAGE_LENGTH | `fixed` 4096 characters | — | Message length bound; a longer `message` returns `message-too-long` (R3.9) |
| SCHEDULER_CATCH_UP_MARKER | `fixed` the literal ` [catch-up: delivered after the scheduled fire time]` | — | Text appended to the scheduler/fired-message of a scheduler/catch-up-fire (R7.2) |
| SCHEDULER_RELATIVE_AT_UNITS | `fixed` unit letters `s`, `m`, `h`, `d` | — | Unit letters accepted after the positive integer of a scheduler/relative-at; any other unit letter or shape returns `invalid-at` (R3.10) |
| SCHEDULER_RELATIVE_AT_CLOCK_SHAPE | `fixed` the clock form `HH:MM:SS` — hours `00`-`99`, minutes `00`-`59`, seconds `00`-`59`, three colon-separated two-digit groups | — | Clock form accepted after the `now+` prefix of a scheduler/relative-at; the offset is its hours plus its minutes plus its seconds, and hours may reach past a full day; any other shape returns `invalid-at` (R3.10) |
| SCHEDULER_MAX_COMMAND_LENGTH | `fixed` 4096 characters | — | Command length bound; a longer `command` returns `command-too-long` (R3.13) |
| SCHEDULER_GATE_SHELL | `fixed` the invocation `bash -c` | — | Interpreter of a scheduler/gate-run: the stored command text runs as the single argument of `bash -c` (R6.17) |
| SCHEDULER_GATE_WORKING_DIRECTORY | `fixed` the location directory of the owning session | — | Working directory of every scheduler/gate-run (R6.18) |
| SCHEDULER_GATE_TIMEOUT | `fixed` none — a scheduler/gate-run is never cut short | — | Deliberate no-timeout: a run may execute arbitrarily long, and the loop isolation of R8.6 with the single-flight hold of R8.7-R8.9 keeps every other schedule serving meanwhile |
| SCHEDULER_GATE_OUTPUT_HEADER | `fixed` the literal `\ngate command output:\n` — a line break, the header text, a line break | — | Opens the scheduler/gate-output-section (R6.14) |
| SCHEDULER_MAX_GATE_OUTPUT_LENGTH | `fixed` 4096 characters | — | Combined-output bound of the scheduler/gate-output-section; longer output is truncated to the bound with an ellipsis character appended (R6.14) |

## Requirements

- R1. Tool surface:
- R1.1. The scheduler tool is a V1 built-in registered in the V1 tool registry and defined under the V1 tool contract.
- R1.2. The tool selects one of the actions add, remove, and list through its `action` argument.
- R1.3. Args that fail schema decode return the `invalid-arguments` error result.
- R1.4. An add result echoes the schedule id, the spec form, and the scheduler/next-due-time in UTC. An add carrying a `command` ends its result line with the scheduler/gate-echo.
- R1.5. A list result carries one line per scheduler/schedule of the calling session, each with the schedule id, the spec form, the scheduler/next-due-time in UTC, and the message text. A line of a scheduler/schedule with a stored scheduler/gate-command ends with the scheduler/gate-echo.
- R1.6. A remove result confirms the removed schedule id.
- R2. Session binding:
- R2.1. Every scheduler/schedule is bound to the session of the tool call that created it.
- R2.2. A list result contains only scheduler/schedule records bound to the calling session.
- R2.3. A remove acts only on a scheduler/schedule bound to the calling session; an unknown or foreign `id` returns `schedule-not-found` and removes nothing.
- R2.4. An add returns `schedule-cap-reached` when the calling session already holds SCHEDULER_MAX_SCHEDULES_PER_SESSION schedules.
- R3. Schedule spec input:
- R3.1. An add carries exactly one of `every`, `cron`, and `at`; any other combination returns `schedule-spec-conflict` and stores nothing.
- R3.2. An `every` value is a positive integer followed by one of the unit letters `m`, `h`, and `d`; any other form returns `invalid-interval`.
- R3.3. An `every` value converts at add time into the stored scheduler/cron-spec, and only the cron-spec is stored, echoed, and fired.
- R3.4. A `cron` value is a standard five-field cron expression; a malformed expression returns `invalid-cron`.
- R3.5. A `cron` value with no future match returns `cron-without-future-match`.
- R3.6. An `at` value is an ISO 8601 datetime or a scheduler/relative-at; a value that is neither returns `invalid-at`.
- R3.7. A naive `at` resolves in the process timezone at add time into UTC, and a zoned `at` resolves into the UTC equivalent of its offset.
- R3.8. An `at` that resolves to a time not after the current time returns `at-in-past`.
- R3.9. A `message` longer than SCHEDULER_MAX_MESSAGE_LENGTH returns `message-too-long`.
- R3.10. A scheduler/relative-at is the prefix `now+` followed either by a positive integer and one unit letter of SCHEDULER_RELATIVE_AT_UNITS or by the clock form of SCHEDULER_RELATIVE_AT_CLOCK_SHAPE, with no other characters; a value of any other shape returns `invalid-at`.
- R3.11. A scheduler/relative-at resolves at add time into the UTC due time equal to the current time plus its offset.
- R3.12. Only the absolute UTC due time of a scheduler/relative-at is stored, echoed, and fired; the relative form itself never appears in a stored row, a tool result, or a scheduler/fired-message.
- R3.13. A `command` longer than SCHEDULER_MAX_COMMAND_LENGTH returns `command-too-long`.
- R4. Persistence:
- R4.1. Scheduler/schedule state persists in the schedule table with snake_case columns under the table-ownership rules of storage-events.
- R4.2. Deleting a session row deletes every scheduler/schedule bound to it through the cascading foreign key.
- R4.3. The schedule table registers through the generated migration pipeline of storage-events.
- R4.4. Scheduler/schedule records survive a process restart.
- R5. Permissions:
- R5.1. An add or remove performs its `scheduler` permission ask through the V1 ask flow before any side effect.
- R5.2. A denied ask fails the tool call with `permission-denied` and stores or removes nothing.
- R5.3. A list performs no permission ask.
- R5.4. A scheduler/fire performs no permission ask.
- R5.5. A scheduler/gate-run performs no permission ask.
- R6. Firing and delivery:
- R6.1. All due-time evaluation runs in UTC against the stored scheduler/next-due-time.
- R6.2. A scheduler/fire delivers when the current time reaches the scheduler/next-due-time of a stored scheduler/schedule.
- R6.3. For a session served by the V2 runtime, a fire publishes one `SessionEvent.ContextUpdated` durable event carrying the scheduler/fired-message, and the publish advances no context epoch.
- R6.4. For a session served by the V2 runtime, a fire admits one durable input carrying the scheduler/fired-message and then wakes the session execution so the serialized drain begins.
- R6.5. For a session served by the V1 runtime, a fire appends one synthetic user text part carrying the scheduler/fired-message and admits it through the V1 prompt path.
- R6.6. Every fire carries exactly one scheduler/fired-message following the fixed fired-message grammar, with the scheduler/scheduled-fire-time as its timestamp.
- R6.7. For a scheduler/schedule created from `every`, the spec form in results and fired messages is the converted scheduler/cron-spec.
- R6.8. After a delivered fire of a scheduler/recurring schedule, the scheduler/next-due-time advances to the earliest match strictly after the discharged scheduler/scheduled-fire-time.
- R6.9. A scheduler/one-shot is removed after its delivered fire.
- R6.10. A fire whose owning session no longer exists removes the scheduler/schedule and delivers nothing.
- R6.11. A scheduler/schedule with no stored scheduler/gate-command performs no scheduler/gate-run.
- R6.12. A fire of a scheduler/schedule with a stored scheduler/gate-command performs its scheduler/gate-run before any delivery side effect of that fire.
- R6.13. A fire of a scheduler/schedule with a stored scheduler/gate-command delivers only when its scheduler/gate-run exits with status zero.
- R6.14. A fire whose scheduler/gate-run exits with status zero appends the scheduler/gate-output-section to its scheduler/fired-message when the run wrote output.
- R6.15. A scheduler/recurring schedule whose fire is a scheduler/suppressed-fire advances its scheduler/next-due-time to the earliest match strictly after the discharged scheduler/scheduled-fire-time.
- R6.16. A scheduler/one-shot whose fire is a scheduler/suppressed-fire is removed.
- R6.17. A scheduler/gate-run executes the stored command text as the single argument of the shell invocation of SCHEDULER_GATE_SHELL.
- R6.18. A scheduler/gate-run runs with the working directory SCHEDULER_GATE_WORKING_DIRECTORY.
- R7. Missed-fire catch-up:
- R7.1. A fire is a scheduler/catch-up-fire when its scheduler/scheduled-fire-time precedes the load of the scheduler/service in the current process, or when it retries a previously failed delivery, or when its scheduler/scheduled-fire-time was reached while a scheduler/gate-run of the same scheduler/schedule was in flight.
- R7.2. A scheduler/catch-up-fire appends the catch-up marker to the scheduler/fired-message.
- R7.3. At scheduler/service load, every scheduler/recurring schedule with a past scheduler/next-due-time receives exactly one scheduler/catch-up-fire at the first opportunity.
- R7.4. After a scheduler/catch-up-fire of a scheduler/recurring schedule, the scheduler/next-due-time advances to the earliest match strictly after the delivery time.
- R7.5. Occurrences skipped between the scheduler/scheduled-fire-time and the delivery time of a scheduler/catch-up-fire are never replayed.
- R7.6. At scheduler/service load, a scheduler/one-shot with a past due time receives exactly one scheduler/catch-up-fire and is then removed.
- R7.7. A scheduler/catch-up-fire of a scheduler/schedule with a stored scheduler/gate-command performs exactly one scheduler/gate-run for its entire skipped series.
- R7.8. The entire skipped series of a scheduler/catch-up-fire that is a scheduler/suppressed-fire is discharged without replay.
- R7.9. A scheduler/recurring schedule whose scheduler/catch-up-fire is a scheduler/suppressed-fire advances its scheduler/next-due-time to the earliest match strictly after the scheduler/gate-run resolution time.
- R8. Scheduler service:
- R8.1. The scheduler/service is a process-global layer node bound in the host application-services graph.
- R8.2. At init the scheduler/service loads every persisted scheduler/schedule, arms its timer, and starts its delivery loop.
- R8.3. All scheduler/schedule mutations and fire deliveries of one process serialize through the single delivery loop of the scheduler/service.
- R8.4. The delivery-loop timer arms at the earliest scheduler/next-due-time among stored schedules and re-arms on every add, remove, fire, and reload.
- R8.5. A fire whose delivery fails is retried by the delivery loop, and its scheduler/schedule is neither advanced nor removed until a delivery succeeds.
- R8.6. The delivery loop keeps serving scheduler/schedule mutations and fire deliveries of other scheduler/schedules while a scheduler/gate-run is in flight.
- R8.7. At most one scheduler/gate-run of one scheduler/schedule is in flight at any time.
- R8.8. A due time of a scheduler/schedule reached while a scheduler/gate-run of that schedule is in flight starts no new scheduler/gate-run.
- R8.9. A due time held by an in-flight scheduler/gate-run is processed after the run resolves as a scheduler/catch-up-fire.
- R8.10. A scheduler/suppressed-fire is not a delivery failure.
- R8.11. A scheduler/suppressed-fire is retried by nothing.
- R9. Visibility limits:
- R9.1. The scheduler never re-delivers a scheduler/fired-message that a later epoch replacement or compaction displaced from visible history.
- R9.2. Fired events and their projected messages receive no scheduler-specific retention and follow ordinary session history and event-log retention.

## Implementation

- I1. An `every` value of n with unit `m` converts to `*/n * * * *`, with unit `h` to `0 */n * * *`, and with unit `d` to `0 0 */n * *`, where n is the positive integer prefix of the value.
- I2. Cron evaluation uses a standard five-field matcher over the UTC clock; the next due time of an instant is the earliest match strictly after it; daylight-saving arithmetic never applies.
- I3. The schedule table lives with the core storage tables, carries a cascading foreign key to the session table, an index on `next_fire_at` for the due-time scan, and an index on `session_id` for list and cascade.
- I4. The scheduler/service depends on the database, the durable event publish path, the session execution service, the session store, the V1 prompt admission path, and the process command runner; hosts bind it in the application-services graph like the other process-global service nodes.
- I5. The V2 admission of a fire uses the admit-only form of the session prompt interface, and the delivery loop issues the execution wake itself after the event publish.
- I6. The delivery loop is the sole writer of schedule rows: serialization through the loop (R8.3) is the ordering of fire deliveries and the mutual exclusion of schedule-row mutations and fire bookkeeping under the loop's single write permit. The write permit is never held across an external model turn. The V1 admission of a fire runs permit-free between the fire's start and finish phases. The finish phase advances or removes the row after the admission.
- I7. At fire time the scheduler/service resolves the owning runtime of the session and routes the delivery to the V2 or the V1 path.
- I8. A scheduler/gate-run executes through the process command runner of the host application-services graph, capturing the combined standard output and error, and its exit status feeds the fire decision of R6.13.
- I9. A scheduler/gate-run runs outside the delivery-loop write permit between the fire's start and finish phases; the write permit is never held across a scheduler/gate-run, and the resolved fire re-enters the serialized finish path for its delivery bookkeeping.
- I10. In-flight scheduler/gate-runs live in process memory only; a restart forgets an in-flight run, and the unadvanced scheduler/next-due-time of its row drives the catch-up path at service load.
- I11. The delivery-loop due scan and timer arm skip scheduler/schedules with an in-flight scheduler/gate-run.

## Examples

- E1. R1 subtree: `action: "add", every: "30m", message: "check CI status"` returns the new schedule id, the spec form `*/30 * * * *`, and the next due time, for example `2026-10-24T13:00:00Z`.
- E1.4. An add of `every: "30m", message: "check CI status", command: "test -f done.flag"` returns the line of E1 ending with the scheduler/gate-echo, for example `Scheduled sch_example (*/30 * * * *), next due 2026-10-24T13:00:00Z [gate: test -f done.flag]`.
- E1.5. The list line of a schedule stored with `command: "test -f done.flag"` reads `sch_example (*/30 * * * *) next due 2026-10-24T13:00:00Z: check CI status [gate: test -f done.flag]`; the echo follows the first `next due` fragment of the line, and a `next due` occurrence inside the echoed command text names no further schedule.
- E2. R2 subtree: session A adds a schedule; session B lists and sees none of it; session B removes A's id and receives `schedule-not-found`.
- E3. R3 subtree: conversion and validation examples follow per requirement.
- E3.2. `every: "45m"` converts to `*/45 * * * *`, which fires at minute 0 and minute 45 of every hour under standard cron restart; the add result shows the cron form, so the model sees the effective rule.
- E3.4. `cron: "0 0 30 2 *"` (minute zero, hour zero, day thirty, February) has no future match and returns `cron-without-future-match`.
- E3.7. In a process running at offset `+03:00`, a naive `at: "2026-11-02T09:00:00"` and a zoned `at: "2026-11-02T09:00:00+03:00"` both store the due time `2026-11-02T06:00:00Z`.
- E3.8. `at: "2020-01-01T00:00:00Z"` returns `at-in-past`.
- E3.10. `at: "now+90s"` and `at: "now+36:00:00"` are accepted; `at: "now+5"`, `at: "now-5m"`, `at: "now+ 5m"`, `at: "now+5x"`, `at: "now+5 m"`, `at: "now+1:2:3"`, `at: "now+25:60:00"`, `at: "now+01:30"`, `at: "now+01:30:25:00"`, and `at: "now+0x:30:25"` each return `invalid-at`.
- E3.11. An add of `at: "now+5m"` when the clock reads `2026-10-25T12:00:00Z` resolves the due time `2026-10-25T12:05:00Z`; `at: "now+2h"` at the same moment resolves `2026-10-25T14:00:00Z`; `at: "now+01:30:25"` at the same moment resolves `2026-10-25T13:30:25Z`.
- E3.12. An add of `at: "now+5m"` echoes the spec form `2026-10-25T12:05:00Z` and never `now+5m`; list lines and the scheduler/fired-message at the due time carry the same absolute form.
- E3.13. A `command` of SCHEDULER_MAX_COMMAND_LENGTH characters is accepted; one character longer returns `command-too-long`.
- E4. R4 subtree: after a full process restart, list still shows the schedule; deleting the session makes it disappear from the table.
- E5. R5 subtree: a denied add returns `permission-denied` and no row appears in list; a list runs without any ask.
- E5.5. A fire running the stored `command: "git status"` performs no permission ask; the storing add asked the `scheduler` permission of R5.1 and nothing more.
- E6. R6 subtree: fired-message examples follow.
- E6.6. A `*/30 * * * *` schedule with message `check CI status` fires the message `2026-10-24T13:00:00Z fired schedule id sch_example */30 * * * *: check CI status`.
- E6.7. An add of `every: "1d"` fires with the spec `0 0 * * *` in the message text.
- E6.11. The schedule of E6.6, added without `command`, fires the message text of E6.6 with no scheduler/gate-output-section.
- E6.12. With `command: "sleep 5m"` no scheduler/fired-message exists at the due time; the fire's delivery side effects begin only after the run exits.
- E6.13. A gate-run of `curl -sf http://ci.local/passed` exiting with status zero at the due time delivers the fire; the same run exiting nonzero delivers nothing.
- E6.14. A `0 * * * *` schedule with message `CI went green` whose gate-run wrote `build 1234 passed` fires `2026-10-24T13:00:00Z fired schedule id sch_example 0 * * * *: CI went green` followed by the line `gate command output:` and the output `build 1234 passed`; a run that writes no output fires the line of E6.6 unchanged.
- E6.15. A `0 * * * *` schedule whose `test -f done.flag` gate-run exits nonzero at `2026-10-24T13:00:00Z` delivers nothing, and its next due time is `2026-10-24T14:00:00Z`.
- E6.16. A scheduler/one-shot whose gate-run exits nonzero is removed silently; a later list no longer shows it, and no scheduler/fired-message ever appeared.
- E6.17. The stored `command: "test -f done.flag"` executes as `bash -c` with the command text as its single argument, whatever the host default shell is.
- E6.18. A gate-run of a schedule whose owning session lives in the workspace `/repo` runs with the working directory `/repo`.
- E7. R7 subtree: a `0 * * * *` schedule due at 13:00 with the process down until 15:37 delivers one catch-up fire at 15:37 with timestamp `2026-10-24T13:00:00Z` and the catch-up marker; the next due time becomes 16:00; the skipped occurrences 14:00 and 15:00 are never replayed.
- E7.6. A one-shot due at 13:00 with the process down until 15:37 fires once at 15:37 with the catch-up marker and is then removed.
- E7.7. A `0 * * * *` schedule with a stored scheduler/gate-command, due at 13:00 with the process down until 15:37, performs one gate-run for the whole skipped series at 15:37; on status zero it delivers one catch-up fire with the marker of E7 and the scheduler/gate-output-section, and on a nonzero exit nothing is delivered.
- E7.8. In the nonzero case of E7.7 the occurrences 14:00 and 15:00 are discharged with the series; the session never learns the schedule reached them.
- E7.9. After the suppressed catch-up of E7.7 resolves at 15:37, the next due time is the earliest match strictly after the resolution time, for example 16:00 for the `0 * * * *` schedule.
- E8. R8 subtree: with a `*/15 * * * *` schedule and a `0 0 * * *` schedule stored, the timer wakes at the nearer due time and re-arms after each fire.
- E8.6. With the gate-run of schedule A in flight, an add from another session stores its schedule, and a due fire of schedule B delivers on time.
- E8.7. A `*/30 * * * *` schedule whose gate-run starts at 13:00 and is still running at 13:30 has exactly one run in flight.
- E8.8. In the state of E8.7 the 13:30 occurrence starts no new gate-run while the 13:00 run is in flight.
- E8.9. The 13:00 run of E8.7 resolving at 13:40 with status zero delivers the 13:00 fire, and the held 13:30 occurrence follows as a scheduler/catch-up-fire with its own gate-run and the catch-up marker.
- E8.10. A `false` gate-command suppressing the 13:00 occurrence of a `0 * * * *` schedule marks no delivery failure; the loop retries nothing, and the schedule next runs its gate at 14:00.
- E9. R9 subtree: after a compaction displaces an old fired system message from visible history, the scheduler sends nothing new before the next due time.

## Tests

- T1. Tool surface:
- T1.1. registry-exposes-scheduler-tool (R1.1, R1.2)
- T1.2. decode-failure-returns-invalid-arguments (R1.3)
- T1.3. add-result-echoes-id-spec-next-due (R1.4, R3.3)
- T1.4. list-lines-carry-id-spec-next-message (R1.5)
- T1.5. remove-confirms-id (R1.6)
- T1.6. add-result-appends-gate-echo (R1.4)
- T1.7. list-lines-append-gate-echo (R1.5)
- T2. Session binding:
- T2.1. list-isolated-to-calling-session (R2.1, R2.2)
- T2.2. remove-foreign-or-unknown-id-rejected (R2.3)
- T2.3. add-rejected-at-per-session-cap (R2.4)
- T3. Schedule spec input:
- T3.1. every-unit-conversion-covers-units (R3.2, R3.3, I1)
- T3.2. spec-conflict-rejected (R3.1)
- T3.3. cron-malformed-rejected (R3.4)
- T3.4. cron-without-future-match-rejected (R3.5)
- T3.5. at-naive-resolves-process-timezone (R3.7)
- T3.6. at-zoned-resolves-offset (R3.7)
- T3.7. at-in-past-rejected (R3.8)
- T3.8. message-over-cap-rejected (R3.9)
- T3.9. relative-at-unit-and-clock-grammar-accepted (R3.10)
- T3.10. relative-at-covers-each-unit (R3.10, R3.11)
- T3.11. relative-at-converts-against-current-clock (R3.11)
- T3.12. relative-at-stored-and-echoed-absolute-only (R3.12)
- T3.13. relative-at-unit-and-clock-malformed-rejected (R3.10)
- T3.14. command-over-cap-rejected (R3.13)
- T4. Persistence:
- T4.1. schedule-table-owns-rows-with-cascade (R4.1, R4.2, I3)
- T4.2. migration-registers-table (R4.3)
- T4.3. schedules-survive-restart (R4.4)
- T5. Permissions:
- T5.1. add-and-remove-ask-scheduler-permission (R5.1)
- T5.2. deny-leaves-state-untouched (R5.2)
- T5.3. list-asks-nothing (R5.3)
- T5.4. fire-asks-nothing (R5.4)
- T5.5. gate-run-asks-nothing (R5.5)
- T6. Firing and delivery:
- T6.1. v2-fire-publishes-context-updated-without-epoch-advance (R6.3)
- T6.2. v2-fire-admits-input-and-wakes-execution (R6.4, I5)
- T6.3. v1-fire-delivers-synthetic-user-part (R6.5)
- T6.4. fired-message-follows-grammar (R6.6)
- T6.5. every-created-schedule-fires-cron-form (R6.7)
- T6.6. recurring-advances-from-discharged-time (R6.1, R6.8, I2)
- T6.7. one-shot-removed-after-fire (R6.9)
- T6.8. dead-session-drops-schedule (R6.10)
- T6.9. gate-runs-before-delivery-side-effects (R6.12)
- T6.10. gate-zero-exit-delivers (R6.13)
- T6.11. gate-output-section-appended-and-truncated (R6.14)
- T6.12. gate-nonzero-recurring-advances (R6.15)
- T6.13. gate-nonzero-one-shot-removed (R6.16)
- T6.14. commandless-schedule-fires-unchanged (R6.11)
- T6.15. gate-shell-invocation-and-working-directory (R6.17, R6.18)
- T7. Catch-up:
- T7.1. restart-delivers-one-catch-up-per-recurring (R7.3)
- T7.2. catch-up-carries-marker (R7.2)
- T7.3. catch-up-advances-from-delivery-time (R7.4)
- T7.4. skipped-occurrences-not-replayed (R7.5)
- T7.5. missed-one-shot-fires-then-removed (R7.6)
- T7.6. failed-delivery-retry-is-catch-up (R7.1, R8.5)
- T7.7. catch-up-runs-gate-once-per-series (R7.7)
- T7.8. suppressed-catch-up-discharges-series (R7.8)
- T7.9. suppressed-catch-up-advances-from-resolution (R7.9)
- T7.10. gate-held-occurrence-is-catch-up (R7.1)
- T8. Scheduler service:
- T8.1. init-loads-schedules-and-arms-timer (R8.2, R8.4, I5)
- T8.2. mutations-serialize-through-loop (R8.3, I6)
- T8.3. routing-selects-runtime-path (I7)
- T8.4. loop-serves-others-while-gate-in-flight (R8.6)
- T8.5. single-gate-run-per-schedule-in-flight (R8.7)
- T8.6. held-due-starts-no-second-run (R8.8)
- T8.7. held-due-processed-after-resolution (R8.9)
- T8.8. suppressed-fire-not-retried (R8.10, R8.11)
- T9. Visibility:
- T9.1. no-redelivery-after-epoch-replacement (R9.1)
- T9.2. fired-events-follow-ordinary-retention (R9.2)

## Justification

- J1. Why a V2 fire both publishes a system message and admits a durable input (R6.3, R6.4): an advisory wake without pending input starts no drain, so the admitted input is the load-bearing wake; the system message records the fire in durable history with machine provenance, and carrying the same text in both keeps each self-contained when one of them leaves the visible window.
- J2. Why `every` converts to a stored cron-spec and only the cron-spec is kept (R3.3, I1): one canonical firing rule keeps storage, results, and fired messages consistent, and the echoed cron form exposes the hour-boundary restart effect of step expressions to the model at add time.
- J3. Why catch-up fires once and advances from the delivery time (R7.3, R7.4): replaying every missed occurrence after a long downtime would flood the session with redundant turns, while one marked fire preserves the information that something was missed at constant cost.
- J4. Why losing a fired system message to a later epoch replacement or compaction is acceptable (R9.1, R9.2): the fired message is a transient nudge, not durable state; the schedule row survives and fires again on its next occurrence, so the loss degrades at most one reminder.
- J5. Why an `at` in the past is rejected instead of firing immediately (R3.8): an add whose due time already passed would race the tool response with a fire the model never saw scheduled; a typed error result hands the model a correctable mistake.
- J6. Why the per-session cap and the message length bound are baked constants instead of config keys (see Configuration): the scheduler is an initial surface with no demonstrated tuning need, and fixed bounds keep the add path total on bounded input and bounded table growth.
- J7. Why the fired-message timestamp is the scheduled fire time rather than the publish time (R6.6): the timestamp identifies the discharged occurrence, stays stable across delivery retries, and makes a duplicate from the crash window of Error handling recognizable.
- J8. Why `at` accepts a scheduler/relative-at alongside ISO 8601 datetimes (R3.10-R3.12): the model cannot be trusted to know the current wall-clock time, so an authored absolute datetime can silently land in the past or far from intent; the offset form derives the due time from the process clock at add time and removes the hallucinated-timestamp failure mode.
- J9. Why a scheduler/gate-run has no timeout (SCHEDULER_GATE_TIMEOUT, R8.6-R8.9): an event check may legitimately wait arbitrarily long, a fixed timeout would suppress fires whose event occurs just past it, and the loop isolation plus the single-flight hold already bound what an unbounded run can delay — one schedule's own occurrences.
- J10. Why a nonzero exit suppresses instead of failing the delivery (R6.15, R6.16, R7.8, R7.9, R8.10, R8.11): the gate checks an event, and not-yet is a normal answer; classifying it as a delivery failure would re-run the command on the loop's retry cadence and hot-loop a check that keeps failing.
- J11. Why the gate output rides a separate section instead of the message text (R6.14, SCHEDULER_GATE_OUTPUT_HEADER, SCHEDULER_MAX_GATE_OUTPUT_LENGTH): the stored message is model-authored and echoed by list results and fired messages alike, so embedding raw output would break the fixed grammars; a delimited, bounded section keeps every existing line intact and the output recognizable.
- J12. Why no permission ask guards the scheduler/gate-run (R5.5): the storing add already passed the `scheduler` permission ask with the command echoed in its result, and a fire-time ask would leave every occurrence of the schedule waiting on a prompt nobody may answer.

## Error handling

- All error results of the tool are final results of a failed tool call; the tool retries nothing itself, and the model may re-call with corrected arguments.
- A denied permission ask follows the V1 ask flow: the deny fails the call with `permission-denied` before any side effect, in line with the invariant that no privileged side effect precedes the resolved ask.
- An add stores its row only after argument validation and the permission ask succeed; a remove deletes only after its ask succeeds; failed calls leave no partial state.
- A delivery failure is retried by the delivery loop (R8.5); until success the schedule stays due, so the retry surfaces as a scheduler/catch-up-fire (R7.1).
- A crash between a successful delivery publish and the row advance may re-deliver the same occurrence once after restart; the repeated scheduler/scheduled-fire-time in the fired-message text makes the duplicate recognizable. This window is an accepted risk.
- A fire for a session whose row is gone drops the schedule silently, with a log line and no event (R6.10).
- A scheduler/gate-run that fails to spawn or dies to a signal counts as a nonzero exit status and suppresses its fire; the combined output of a scheduler/suppressed-fire's run is discarded.
- A scheduler/gate-run in flight is not persisted: a crash abandons the run and its output, and the restart catch-up path of R7.3 performs one fresh run for the row's unadvanced scheduler/next-due-time (R7.7).
- The delivery loop assumes single-process write ownership of the database, per the storage constraint of storage-events; concurrent processes against one database may double-fire and are out of scope.

## Dependencies

- core-session — the delivery path rides its interfaces: durable prompt admission and the serialized drain, the `SessionEvent.ContextUpdated` durable event and its projection, history selection and the epoch baseline, and the V1 runtime boundary.
- core-tools-permissions — the scheduler tool is a V1 built-in under its tool contract and registry, and gates add and remove through its session ask flow and permission matrix.
- storage-events — the schedule table follows its table-ownership and column conventions (R11, R12, R14) and registers through its generated migration pipeline (R10); fires publish through its durable publish transaction (R15-R18); the delivery loop assumes its single-writer constraint.

## Used by

- scheduler-view (R1.4, R1.5) — its annotator parses the add and list success text as its input contract; its schedule-list endpoint reuses the schedule record fields and the scheduler/service as its list source.
- tool-task (R2.3) — cites the single-delivery-loop property (R8.3) as the process-topology precondition of its completion-message delivery; no scheduler behavior changes there.
