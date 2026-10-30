# Scheduler Tool

Status: stable
Reference: scheduler
Spec source of truth for: the AI-facing scheduler — the `scheduler` tool (actions add, remove, list), session-bound persisted schedules, the schedule display name, the interval, cron, and one-shot time-spec inputs, the optional scheduler/gate-command checked before each fire, fire delivery into sessions served by the V2 and the V1 runtime, missed-fire catch-up, permission gating, and the process-global scheduler service with its single delivery loop.

## Overview

The scheduler lets the model running inside a session schedule future events for itself. A scheduler/schedule carries a firing rule, a display name, a message text, and an optional scheduler/gate-command; at each due time the scheduler/service first runs the stored gate command when one exists, and delivers a scheduler/fired-message into the owning session when the run exits with status zero, so the model sees it and continues work (R6). A nonzero exit status suppresses the fire and writes one diagnostic log record, so a suppressing schedule stays observable outside the session: the event the command checks has not occurred (R6.13, R6.15, R6.16, R6.19). Schedules are created and managed through the `scheduler` tool (R1), are bound to the creating session (R2), and persist in the schedule table across process restarts (R4). Adding and removing asks the `scheduler` permission through the V1 ask flow (R5); firing itself is not a tool call and asks nothing, the gate command included (R5.4, R5.5). Every add names its scheduler/schedule through the required `name` argument; scheduler-view shows the name to the user in the session sidebar in place of the message text, and legacy schedules created before the field carry none.

The scheduler core ships no HTTP surface of its own: no protocol group, no handler, and no SDK regeneration belong to it. The one exception is the read-only schedule-list endpoint, owned by scheduler-view, which reads scheduler/schedule rows through the scheduler/service as its data source.

Fired messages are transient nudges, not durable state. The schedule row is the durable artifact; a fired message displaced from visible history by a later epoch replacement or compaction is never re-delivered (R9). History filtering of discarded assistant and user parts never touches a fired system message, because system messages are not eligible filtering parts. Schedule state lives in a table, not in the event log, so event-log pruning never removes a schedule.

## Scope

In:

- The `scheduler` tool surface: actions add, remove, list; argument domains; success and error result contracts.
- The schedule display name: the required `name` argument of add, its bound SCHEDULER_MAX_NAME_LENGTH, its storage as the nullable `name` column, and its echo in add and list results.
- Schedule spec inputs: interval (`every`), cron expression (`cron`), one-shot datetime or scheduler/relative-at (`at`); conversion, validation, and storage rules.
- The optional scheduler/gate-command of a scheduler/schedule: the `command` argument, validation, execution before each fire, suppression of fires and its diagnostic log record, catch-up interplay, and the scheduler/gate-output-section.
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

- **scheduler/schedule**: a persisted record binding a firing rule, a display name, a message text, and an optional scheduler/gate-command to the session whose tool call created it; identified by a `sch_`-prefixed id.
- **scheduler/name**: the display name of a scheduler/schedule, set by the required `name` argument of its add and shown to the user in the session sidebar of scheduler-view in place of the message text; null on a legacy scheduler/schedule created before the field existed.
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
- **scheduler/name-echo**: the single-line fragment that ends the add success result and the list lines of a scheduler/schedule with a non-null name, per the name-echo grammar of the Interface section.
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
| `name` | add | non-empty string, at most SCHEDULER_MAX_NAME_LENGTH characters — the display name of the created scheduler/schedule, shown to the user in the session sidebar of scheduler-view; it should briefly state what the schedule does and why it fires |
| `every` | add, optional | positive integer followed by one of the unit letters `m`, `h`, `d` (for example `30m`, `1h`, `1d`) |
| `cron` | add, optional | standard five-field cron expression |
| `at` | add, optional | `ISO 8601` datetime, naive or zoned, or a scheduler/relative-at: the unit form `now+<positive integer><unit letter>` with the unit letters of SCHEDULER_RELATIVE_AT_UNITS, or the clock form `now+HH:MM:SS` with the shape and bounds of SCHEDULER_RELATIVE_AT_CLOCK_SHAPE (for example `now+5m`, `now+01:30:25`) |
| `command` | add, optional | non-empty string, at most SCHEDULER_MAX_COMMAND_LENGTH characters — the scheduler/gate-command text |
| `id` | remove | schedule id |

`every`, `cron`, and `at` are mutually exclusive; an add carries exactly one of them. The scheduler/relative-at forms are accepted only by `at` and never by `every` or `cron`. `list` takes no further arguments. `command` is independent of the spec inputs: an add may carry it with any one of them, and an add without `command` stores no scheduler/gate-command. `name` is required on every add and independent of the spec inputs and of `command`.

Success results (model-facing text):

- add: echoes the schedule id, the spec form (the stored scheduler/cron-spec, or the stored UTC datetime of a scheduler/one-shot), the scheduler/next-due-time in UTC, and the `name`. The result line ends with the scheduler/name-echo; an add carrying a `command` places the scheduler/gate-echo immediately before it.
- list: one line per scheduler/schedule of the calling session, each carrying the schedule id, the spec form, the scheduler/next-due-time in UTC, the message text, and — for a non-null name — the name; no schedules yields an empty listing. A line of a scheduler/schedule with a stored scheduler/gate-command ends with the scheduler/gate-echo, and a line of a scheduler/schedule with a non-null name ends with the scheduler/name-echo; the line of a legacy scheduler/schedule with a null name carries no name fragment.
- remove: confirms the removed schedule id.

Error results (the complete set; semantics in Error handling):

| Error result | Meaning |
|---|---|
| `invalid-arguments` | args fail schema decode: wrong types, a missing or empty `name` on add, missing `id`, unknown action (R1.3) |
| `schedule-spec-conflict` | add carries zero or more than one of `every`, `cron`, `at` (R3.1) |
| `invalid-interval` | `every` is malformed (R3.2) |
| `invalid-cron` | `cron` is malformed (R3.4) |
| `cron-without-future-match` | `cron` has no future match (R3.5) |
| `invalid-at` | `at` is unparseable as an `ISO 8601` datetime or a scheduler/relative-at (R3.6, R3.10) |
| `at-in-past` | `at` resolves to a time not after the current time (R3.8) |
| `message-too-long` | `message` is longer than SCHEDULER_MAX_MESSAGE_LENGTH (R3.9) |
| `name-too-long` | `name` is longer than SCHEDULER_MAX_NAME_LENGTH (R3.14) |
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
| `name` | nullable string, no default | display name shown to the user in the session sidebar; null on a legacy row created before the field existed |
| `message` | string | message text delivered on fire |
| `command` | nullable string | the stored scheduler/gate-command text |
| `next_fire_at` | UTC timestamp, integer epoch milliseconds | stored scheduler/next-due-time |
| `created_at`, `updated_at` | timestamps | shared timestamp columns |

Exactly one of `cron` and `at` is non-null per row. A null `command` stores no scheduler/gate-command. The `name` column is nullable with no default: a null `name` marks a legacy row created before the `name` argument existed, and every row created by an add carries a non-null `name`.

### Fired-message grammar

```
<scheduled-fire-time> fired schedule id <id> <spec>: <message><catch-up-marker><gate-output-section>
```

- `<scheduled-fire-time>`: the scheduler/scheduled-fire-time, UTC, `ISO 8601`.
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

- The fragment ends the add and list success lines of a scheduler/schedule with a stored scheduler/gate-command, immediately before the scheduler/name-echo when the line carries one.
- `<command>`: the stored command text with every whitespace run collapsed to a single space.
- The fragment never precedes the `next due` fragment of its line and never introduces a line break, so the first `next due` fragment of the line keeps naming its schedule.

### Name echo

```
 [name: <name>]
```

- The fragment ends the add success line of every add and the list line of every scheduler/schedule with a non-null name; the line of a legacy scheduler/schedule with a null name carries no name fragment.
- `<name>`: the stored scheduler/name with every whitespace run collapsed to a single space.
- The fragment is the last fragment of its line: it follows the scheduler/gate-echo when that echo is present, and it never precedes the `next due` fragment of its line.
- The fragment never introduces a line break, so every result line stays single-line and the first `next due` fragment and the first `sch_`-prefixed token of the line keep naming their schedule.

### Permission ask

Add and remove ask through the V1 permission flow under the permission name `scheduler`; the pattern set of an add ask is the spec form, the pattern set of a remove ask is the schedule id; list asks nothing (R5). A `command` of an add joins no pattern set and asks nothing beyond the add ask, and so does its `name`: the pattern set of an add ask stays the spec form, and the ask metadata may carry the name text as descriptive context, like the message text.

### Delivery boundary

A fire of a session served by the V2 runtime: one `SessionEvent.ContextUpdated` durable event carrying the scheduler/fired-message with no context-epoch advance, one admitted durable input carrying the same text, and one execution wake (R6.3, R6.4). A fire of a session served by the V1 runtime: one synthetic user text part carrying the scheduler/fired-message, admitted through the V1 prompt path (R6.5).

## Configuration

| Name | Allowed values | Default | Effect |
|---|---|---|---|
| SCHEDULER_MAX_SCHEDULES_PER_SESSION | `fixed` 50 schedules | — | Per-session add cap; an add that would exceed it returns `schedule-cap-reached` (R2.4) |
| SCHEDULER_MAX_MESSAGE_LENGTH | `fixed` 4096 characters | — | Message length bound; a longer `message` returns `message-too-long` (R3.9) |
| SCHEDULER_MAX_NAME_LENGTH | `fixed` 32 characters | — | Name length bound; a longer `name` returns `name-too-long` (R3.14) |
| SCHEDULER_CATCH_UP_MARKER | `fixed` the literal ` [catch-up: delivered after the scheduled fire time]` | — | Text appended to the scheduler/fired-message of a scheduler/catch-up-fire (R7.2) |
| SCHEDULER_RELATIVE_AT_UNITS | `fixed` unit letters `s`, `m`, `h`, `d` | — | Unit letters accepted after the positive integer of a scheduler/relative-at; any other unit letter or shape returns `invalid-at` (R3.10) |
| SCHEDULER_RELATIVE_AT_CLOCK_SHAPE | `fixed` the clock form `HH:MM:SS` — hours `00`-`99`, minutes `00`-`59`, seconds `00`-`59`, three colon-separated two-digit groups | — | Clock form accepted after the `now+` prefix of a scheduler/relative-at; the offset is its hours plus its minutes plus its seconds, and hours may reach past a full day; any other shape returns `invalid-at` (R3.10) |
| SCHEDULER_MAX_COMMAND_LENGTH | `fixed` 4096 characters | — | Command length bound; a longer `command` returns `command-too-long` (R3.13) |
| SCHEDULER_GATE_SHELL | `fixed` the invocation `bash -c` | — | Interpreter of a scheduler/gate-run: the stored command text runs as the single argument of `bash -c` (R6.17) |
| SCHEDULER_GATE_WORKING_DIRECTORY | `fixed` the location directory of the owning session | — | Working directory of every scheduler/gate-run (R6.18) |
| SCHEDULER_GATE_TIMEOUT | `fixed` none — a scheduler/gate-run is never cut short | — | Deliberate no-timeout: a run may execute arbitrarily long, and the loop isolation of R8.6 with the single-flight hold of R8.7-R8.9 keeps every other schedule serving meanwhile |
| SCHEDULER_GATE_OUTPUT_HEADER | `fixed` the literal `\ngate command output:\n` — a line break, the header text, a line break | — | Opens the scheduler/gate-output-section (R6.14) |
| SCHEDULER_MAX_GATE_OUTPUT_LENGTH | `fixed` 4096 characters | — | Combined-output bound of the scheduler/gate-output-section; longer output is truncated to the bound with an ellipsis character appended (R6.14) |
| SCHEDULER_GATE_SPAWN_FAILURE_EXIT_CODE | `fixed` exit status 127 | — | Exit status substituted for a scheduler/gate-run that fails to spawn, so the suppression record names the spawn-failure outcome instead of an ordinary command exit (R6.19; Error handling) |
| SCHEDULER_SUPPRESSION_LOG_LEVEL | `fixed` level `info` | — | Severity of the diagnostic log record a scheduler/suppressed-fire writes (R6.19) |
| SCHEDULER_SUPPRESSION_LOG_MARKER | `fixed` the literal `suppressed` | — | Marker naming the scheduler/suppressed-fire in its diagnostic log record (R6.19) |

## Requirements

- R1. Tool surface:
- R1.1. verification=automated; The scheduler tool is a V1 built-in registered in the V1 tool registry and defined under the V1 tool contract.
- R1.2. verification=automated; The tool selects one of the actions add, remove, and list through its `action` argument.
- R1.3. verification=automated; Args that fail schema decode return the `invalid-arguments` error result.
- R1.4. verification=automated; An add result echoes the schedule id, the spec form, the scheduler/next-due-time in UTC, and the `name`, and ends its result line with the scheduler/name-echo; an add carrying a `command` places the scheduler/gate-echo immediately before the name echo.
- R1.5. verification=automated; A list result carries one line per scheduler/schedule of the calling session, each with the schedule id, the spec form, the scheduler/next-due-time in UTC, the message text, and — for a non-null name — the name. A line of a scheduler/schedule with a stored scheduler/gate-command ends with the scheduler/gate-echo; a line of a scheduler/schedule with a non-null name ends with the scheduler/name-echo, and the line of a legacy scheduler/schedule with a null name carries no name fragment.
- R1.6. verification=automated; A remove result confirms the removed schedule id.
- R2. Session binding:
- R2.1. verification=automated; Every scheduler/schedule is bound to the session of the tool call that created it.
- R2.2. verification=automated; A list result contains only scheduler/schedule records bound to the calling session.
- R2.3. verification=automated; A remove acts only on a scheduler/schedule bound to the calling session; an unknown or foreign `id` returns `schedule-not-found` and removes nothing.
- R2.4. verification=automated; An add returns `schedule-cap-reached` when the calling session already holds SCHEDULER_MAX_SCHEDULES_PER_SESSION schedules.
- R3. Schedule spec input:
- R3.1. verification=automated; An add carries exactly one of `every`, `cron`, and `at`; any other combination returns `schedule-spec-conflict` and stores nothing.
- R3.2. verification=automated; An `every` value is a positive integer followed by one of the unit letters `m`, `h`, and `d`; any other form returns `invalid-interval`.
- R3.3. verification=automated; An `every` value converts at add time into the stored scheduler/cron-spec, and only the cron-spec is stored, echoed, and fired.
- R3.4. verification=automated; A `cron` value is a standard five-field cron expression; a malformed expression returns `invalid-cron`.
- R3.5. verification=automated; A `cron` value with no future match returns `cron-without-future-match`.
- R3.6. verification=manual; An `at` value is an `ISO 8601` datetime or a scheduler/relative-at; a value that is neither returns `invalid-at`.
- R3.7. verification=automated; A naive `at` resolves in the process timezone at add time into UTC, and a zoned `at` resolves into the UTC equivalent of its offset.
- R3.8. verification=automated; An `at` that resolves to a time not after the current time returns `at-in-past`.
- R3.9. verification=automated; A `message` longer than SCHEDULER_MAX_MESSAGE_LENGTH returns `message-too-long`.
- R3.10. verification=automated; A scheduler/relative-at is the prefix `now+` followed either by a positive integer and one unit letter of SCHEDULER_RELATIVE_AT_UNITS or by the clock form of SCHEDULER_RELATIVE_AT_CLOCK_SHAPE, with no other characters; a value of any other shape returns `invalid-at`.
- R3.11. verification=automated; A scheduler/relative-at resolves at add time into the UTC due time equal to the current time plus its offset.
- R3.12. verification=automated; Only the absolute UTC due time of a scheduler/relative-at is stored, echoed, and fired; the relative form itself never appears in a stored row, a tool result, or a scheduler/fired-message.
- R3.13. verification=automated; A `command` longer than SCHEDULER_MAX_COMMAND_LENGTH returns `command-too-long`.
- R3.14. verification=automated; A `name` longer than SCHEDULER_MAX_NAME_LENGTH returns `name-too-long`.
- R4. Persistence:
- R4.1. verification=automated; Scheduler/schedule state persists in the schedule table with snake_case columns under the table-ownership rules of storage-events.
- R4.2. verification=automated; Deleting a session row deletes every scheduler/schedule bound to it through the cascading foreign key.
- R4.3. verification=automated; The schedule table registers through the generated migration pipeline of storage-events.
- R4.4. verification=automated; Scheduler/schedule records survive a process restart.
- R5. Permissions:
- R5.1. verification=automated; An add or remove performs its `scheduler` permission ask through the V1 ask flow before any side effect.
- R5.2. verification=automated; A denied ask fails the tool call with `permission-denied` and stores or removes nothing.
- R5.3. verification=automated; A list performs no permission ask.
- R5.4. verification=automated; A scheduler/fire performs no permission ask.
- R5.5. verification=automated; A scheduler/gate-run performs no permission ask.
- R6. Firing and delivery:
- R6.1. verification=automated; All due-time evaluation runs in UTC against the stored scheduler/next-due-time.
- R6.2. verification=automated; A scheduler/fire delivers when the current time reaches the scheduler/next-due-time of a stored scheduler/schedule.
- R6.3. verification=automated; For a session served by the V2 runtime, a fire publishes one `SessionEvent.ContextUpdated` durable event carrying the scheduler/fired-message, and the publish advances no context epoch.
- R6.4. verification=automated; For a session served by the V2 runtime, a fire admits one durable input carrying the scheduler/fired-message and then wakes the session execution so the serialized drain begins.
- R6.5. verification=automated; For a session served by the V1 runtime, a fire appends one synthetic user text part carrying the scheduler/fired-message and admits it through the V1 prompt path.
- R6.6. verification=automated; Every fire carries exactly one scheduler/fired-message following the fixed fired-message grammar, with the scheduler/scheduled-fire-time as its timestamp.
- R6.7. verification=automated; For a scheduler/schedule created from `every`, the spec form in results and fired messages is the converted scheduler/cron-spec.
- R6.8. verification=automated; After a delivered fire of a scheduler/recurring schedule, the scheduler/next-due-time advances to the earliest match strictly after the discharged scheduler/scheduled-fire-time.
- R6.9. verification=automated; A scheduler/one-shot is removed after its delivered fire.
- R6.10. verification=automated; A fire whose owning session no longer exists removes the scheduler/schedule and delivers nothing.
- R6.11. verification=automated; A scheduler/schedule with no stored scheduler/gate-command performs no scheduler/gate-run.
- R6.12. verification=automated; A fire of a scheduler/schedule with a stored scheduler/gate-command performs its scheduler/gate-run before any delivery side effect of that fire.
- R6.13. verification=automated; A fire of a scheduler/schedule with a stored scheduler/gate-command delivers only when its scheduler/gate-run exits with status zero; each suppression this decides writes the diagnostic log record of R6.19.
- R6.14. verification=automated; A fire whose scheduler/gate-run exits with status zero appends the scheduler/gate-output-section to its scheduler/fired-message when the run wrote output.
- R6.15. verification=automated; A scheduler/recurring schedule whose fire is a scheduler/suppressed-fire advances its scheduler/next-due-time to the earliest match strictly after the discharged scheduler/scheduled-fire-time.
- R6.16. verification=automated; A scheduler/one-shot whose fire is a scheduler/suppressed-fire is removed.
- R6.17. verification=automated; A scheduler/gate-run executes the stored command text as the single argument of the shell invocation of SCHEDULER_GATE_SHELL.
- R6.18. verification=automated; A scheduler/gate-run runs with the working directory SCHEDULER_GATE_WORKING_DIRECTORY.
- R6.19. verification=automated; Every scheduler/suppressed-fire writes exactly one diagnostic log record of the host process at level SCHEDULER_SUPPRESSION_LOG_LEVEL carrying the schedule id, the exit status of its scheduler/gate-run, and the marker SCHEDULER_SUPPRESSION_LOG_MARKER.
- R7. Missed-fire catch-up:
- R7.1. verification=automated; A fire is a scheduler/catch-up-fire when its scheduler/scheduled-fire-time precedes the load of the scheduler/service in the current process, or when it retries a previously failed delivery, or when its scheduler/scheduled-fire-time was reached while a scheduler/gate-run of the same scheduler/schedule was in flight.
- R7.2. verification=automated; A scheduler/catch-up-fire appends the catch-up marker to the scheduler/fired-message.
- R7.3. verification=automated; At scheduler/service load, every scheduler/recurring schedule with a past scheduler/next-due-time receives exactly one scheduler/catch-up-fire at the first opportunity.
- R7.4. verification=automated; After a scheduler/catch-up-fire of a scheduler/recurring schedule, the scheduler/next-due-time advances to the earliest match strictly after the delivery time.
- R7.5. verification=automated; Occurrences skipped between the scheduler/scheduled-fire-time and the delivery time of a scheduler/catch-up-fire are never replayed.
- R7.6. verification=automated; At scheduler/service load, a scheduler/one-shot with a past due time receives exactly one scheduler/catch-up-fire and is then removed.
- R7.7. verification=automated; A scheduler/catch-up-fire of a scheduler/schedule with a stored scheduler/gate-command performs exactly one scheduler/gate-run for its entire skipped series.
- R7.8. verification=automated; The entire skipped series of a scheduler/catch-up-fire that is a scheduler/suppressed-fire is discharged without replay.
- R7.9. verification=automated; A scheduler/recurring schedule whose scheduler/catch-up-fire is a scheduler/suppressed-fire advances its scheduler/next-due-time to the earliest match strictly after the scheduler/gate-run resolution time.
- R8. Scheduler service:
- R8.1. verification=manual; The scheduler/service is a process-global layer node bound in the host application-services graph.
- R8.2. verification=automated; At init the scheduler/service loads every persisted scheduler/schedule, arms its timer, and starts its delivery loop.
- R8.3. verification=automated; All scheduler/schedule mutations and fire deliveries of one process serialize through the single delivery loop of the scheduler/service.
- R8.4. verification=automated; The delivery-loop timer arms at the earliest scheduler/next-due-time among stored schedules and re-arms on every add, remove, fire, and reload.
- R8.5. verification=automated; A fire whose delivery fails is retried by the delivery loop, and its scheduler/schedule is neither advanced nor removed until a delivery succeeds.
- R8.6. verification=automated; The delivery loop keeps serving scheduler/schedule mutations and fire deliveries of other scheduler/schedules while a scheduler/gate-run is in flight.
- R8.7. verification=automated; At most one scheduler/gate-run of one scheduler/schedule is in flight at any time.
- R8.8. verification=automated; A due time of a scheduler/schedule reached while a scheduler/gate-run of that schedule is in flight starts no new scheduler/gate-run.
- R8.9. verification=automated; A due time held by an in-flight scheduler/gate-run is processed after the run resolves as a scheduler/catch-up-fire.
- R8.10. verification=automated; A scheduler/suppressed-fire is not a delivery failure.
- R8.11. verification=automated; A scheduler/suppressed-fire is retried by nothing.
- R9. Visibility limits:
- R9.1. verification=automated; The scheduler never re-delivers a scheduler/fired-message that a later epoch replacement or compaction displaced from visible history.
- R9.2. verification=automated; Fired events and their projected messages receive no scheduler-specific retention and follow ordinary session history and event-log retention.

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
- I12. The diagnostic log record of R6.19 emits through the process logger of the host as one entry at level SCHEDULER_SUPPRESSION_LOG_LEVEL — as built `Effect.logInfo` with `Effect.annotateLogs` fields for the schedule id, the gate-run exit status, and the spawn-failure flag — and the marker SCHEDULER_SUPPRESSION_LOG_MARKER rides the entry text.

## Examples

- E1. R1 subtree: result-echo examples of add and list follow:
- E1.4. An add of `every: "30m", name: "CI check", message: "check CI status"` returns the new schedule id, the spec form `*/30 * * * *`, the next due time, and the name echo, for example `Scheduled sch_example (*/30 * * * *), next due 2026-10-24T13:00:00Z [name: CI check]`; an add of the same schedule with `command: "test -f done.flag"` places the scheduler/gate-echo before the name echo, for example `Scheduled sch_example (*/30 * * * *), next due 2026-10-24T13:00:00Z [gate: test -f done.flag] [name: CI check]`.
- E1.5. The list line of a schedule stored with `name: "CI check"` and `command: "test -f done.flag"` reads `sch_example (*/30 * * * *) next due 2026-10-24T13:00:00Z: check CI status [gate: test -f done.flag] [name: CI check]`; the echoes follow the first `next due` fragment of the line, and a `next due` occurrence inside the echoed command or name text names no further schedule.
- E1.6. The list line of a legacy scheduler/schedule created before the `name` argument existed carries no name fragment and reads `sch_legacy (*/30 * * * *) next due 2026-10-24T13:00:00Z: old check`.
- E2. R2 subtree: session A adds a schedule; session B lists and sees none of it; session B removes A's id and receives `schedule-not-found`.
- E3. R3 subtree: conversion and validation examples follow per requirement:
- E3.2. `every: "45m"` converts to `*/45 * * * *`, which fires at minute 0 and minute 45 of every hour under standard cron restart; the add result shows the cron form, so the model sees the effective rule.
- E3.4. `cron: "0 0 30 2 *"` (minute zero, hour zero, day thirty, February) has no future match and returns `cron-without-future-match`.
- E3.7. In a process running at offset `+03:00`, a naive `at: "2026-11-02T09:00:00"` and a zoned `at: "2026-11-02T09:00:00+03:00"` both store the due time `2026-11-02T06:00:00Z`.
- E3.8. `at: "2020-01-01T00:00:00Z"` returns `at-in-past`.
- E3.10. `at: "now+90s"` and `at: "now+36:00:00"` are accepted; `at: "now+5"`, `at: "now-5m"`, `at: "now+ 5m"`, `at: "now+5x"`, `at: "now+5 m"`, `at: "now+1:2:3"`, `at: "now+25:60:00"`, `at: "now+01:30"`, `at: "now+01:30:25:00"`, and `at: "now+0x:30:25"` each return `invalid-at`.
- E3.11. An add of `at: "now+5m"` when the clock reads `2026-10-25T12:00:00Z` resolves the due time `2026-10-25T12:05:00Z`; `at: "now+2h"` at the same moment resolves `2026-10-25T14:00:00Z`; `at: "now+01:30:25"` at the same moment resolves `2026-10-25T13:30:25Z`.
- E3.12. An add of `at: "now+5m"` echoes the spec form `2026-10-25T12:05:00Z` and never `now+5m`; list lines and the scheduler/fired-message at the due time carry the same absolute form.
- E3.13. A `command` of SCHEDULER_MAX_COMMAND_LENGTH characters is accepted; one character longer returns `command-too-long`.
- E4. R4 subtree: after a full process restart, list still shows the schedule; deleting the session makes it disappear from the table.
- E5. R5 subtree: permission examples follow:
- E5.2. A denied add returns `permission-denied` and no row appears in list.
- E5.3. A list runs without any ask.
- E5.5. A fire running the stored `command: "git status"` performs no permission ask; the storing add asked the `scheduler` permission of R5.1 and nothing more.
- E6. R6 subtree: fired-message examples follow:
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
- E7. R7 subtree: catch-up examples follow:
- E7.3. A `0 * * * *` schedule due at 13:00 with the process down until 15:37 delivers one catch-up fire at 15:37 with timestamp `2026-10-24T13:00:00Z` and the catch-up marker; the next due time becomes 16:00; the skipped occurrences 14:00 and 15:00 are never replayed.
- E7.6. A one-shot due at 13:00 with the process down until 15:37 fires once at 15:37 with the catch-up marker and is then removed.
- E7.7. A `0 * * * *` schedule with a stored scheduler/gate-command, due at 13:00 with the process down until 15:37, performs one gate-run for the whole skipped series at 15:37; on status zero it delivers one catch-up fire with the catch-up marker and the scheduler/gate-output-section, and on a nonzero exit nothing is delivered.
- E7.8. In the nonzero case of E7.7 the occurrences 14:00 and 15:00 are discharged with the series; the session never learns the schedule reached them.
- E7.9. After the suppressed catch-up of E7.7 resolves at 15:37, the next due time is the earliest match strictly after the resolution time, for example 16:00 for the `0 * * * *` schedule.
- E8. R8 subtree: delivery-loop examples follow:
- E8.4. With a `*/15 * * * *` schedule and a `0 0 * * *` schedule stored, the timer wakes at the nearer due time and re-arms after each fire.
- E8.6. With the gate-run of schedule A in flight, an add from another session stores its schedule, and a due fire of schedule B delivers on time.
- E8.7. A `*/30 * * * *` schedule whose gate-run starts at 13:00 and is still running at 13:30 has exactly one run in flight.
- E8.8. In the state of E8.7 the 13:30 occurrence starts no new gate-run while the 13:00 run is in flight.
- E8.9. The 13:00 run of E8.7 resolving at 13:40 with status zero delivers the 13:00 fire, and the held 13:30 occurrence follows as a scheduler/catch-up-fire with its own gate-run and the catch-up marker.
- E8.10. A `false` gate-command suppressing the 13:00 occurrence of a `0 * * * *` schedule marks no delivery failure; the loop retries nothing, and the schedule next runs its gate at 14:00.
- E9. R9 subtree: after a compaction displaces an old fired system message from visible history, the scheduler sends nothing new before the next due time.

## Tests

- T1. Tool surface:
- T1.1. R-ID=R1.1,R1.2; procedure=registry exposure and action dispatch of the scheduler tool; conditions=the V1 tool registry with the scheduler tool registered and one call per action; expected=the tool appears in the registry and dispatches the add, remove, and list actions through `action`.
- T1.2. R-ID=R1.3; procedure=decode-failure handling of the tool; conditions=args of wrong types, a remove missing `id`, and an unknown action; expected=each call returns the `invalid-arguments` error result.
- T1.3. R-ID=R1.4,R3.3; procedure=add-result echo; conditions=an add of `every` and an add of `cron`; expected=each result names the schedule id, the stored scheduler/cron-spec, the scheduler/next-due-time in UTC, and the `name`, ends its line with the scheduler/name-echo, and the `every` add echoes the converted cron-spec.
- T1.4. R-ID=R1.5; procedure=list-result lines; conditions=a session holding schedules with and without a stored scheduler/gate-command; expected=each line carries the schedule id, the spec form, the scheduler/next-due-time in UTC, the message text, and — for a non-null name — the scheduler/name-echo.
- T1.5. R-ID=R1.6; procedure=remove-result confirmation; conditions=a remove of an owned schedule; expected=the result confirms the removed schedule id.
- T1.6. R-ID=R1.4; procedure=gate echo on add results; conditions=an add carrying `command`; expected=the result line carries the scheduler/gate-echo immediately before the scheduler/name-echo.
- T1.7. R-ID=R1.5; procedure=gate echo on list lines; conditions=a schedule with a stored scheduler/gate-command in the listing; expected=its list line carries the scheduler/gate-echo after the first `next due` fragment, immediately before the scheduler/name-echo when the line carries one.
- T1.8. R-ID=R1.3; procedure=missing and empty name decode failure; conditions=an add without `name` and an add with an empty `name`; expected=each call returns the `invalid-arguments` error result.
- T1.9. R-ID=R1.5; procedure=legacy null-name list lines; conditions=a legacy scheduler/schedule stored with a null `name`; expected=its list line carries the message text and no scheduler/name-echo.
- T2. Session binding:
- T2.1. R-ID=R2.1,R2.2; procedure=session isolation of list; conditions=two sessions each holding schedules; expected=list returns only the scheduler/schedules of the calling session.
- T2.2. R-ID=R2.3; procedure=remove of foreign and unknown ids; conditions=a remove naming another session's schedule id and one naming no stored schedule; expected=both return `schedule-not-found` and remove nothing.
- T2.3. R-ID=R2.4; procedure=per-session cap; conditions=a session already holding SCHEDULER_MAX_SCHEDULES_PER_SESSION schedules; expected=the next add returns `schedule-cap-reached`.
- T3. Schedule spec input:
- T3.1. R-ID=R3.2,R3.3; procedure=`every` conversion across units; conditions=adds of `every` values in the `m`, `h`, and `d` units; expected=each is accepted and stored, echoed, and fired as its converted scheduler/cron-spec.
- T3.2. R-ID=R3.1; procedure=spec-conflict rejection; conditions=adds carrying none and more than one of `every`, `cron`, and `at`; expected=each returns `schedule-spec-conflict` and stores nothing.
- T3.3. R-ID=R3.4; procedure=malformed cron rejection; conditions=add of a malformed `cron` value; expected=the add returns `invalid-cron`.
- T3.4. R-ID=R3.5; procedure=cron without future match; conditions=a `cron` value with no future occurrence; expected=the add returns `cron-without-future-match`.
- T3.5. R-ID=R3.7; procedure=naive `at` resolution; conditions=an `at` without offset in a process at a known offset; expected=the stored due time equals its process-timezone resolution in UTC.
- T3.6. R-ID=R3.7; procedure=zoned `at` resolution; conditions=an `at` carrying an explicit offset; expected=the stored due time equals its UTC equivalent.
- T3.7. R-ID=R3.8; procedure=past `at` rejection; conditions=an `at` resolving before the current time; expected=the add returns `at-in-past`.
- T3.8. R-ID=R3.9; procedure=message length bound; conditions=a `message` longer than SCHEDULER_MAX_MESSAGE_LENGTH; expected=the add returns `message-too-long`.
- T3.9. R-ID=R3.10; procedure=relative-at grammar acceptance; conditions=unit-form and clock-form `at` values within SCHEDULER_RELATIVE_AT_UNITS and SCHEDULER_RELATIVE_AT_CLOCK_SHAPE; expected=each is accepted.
- T3.10. R-ID=R3.10,R3.11; procedure=relative-at unit coverage and resolution; conditions=one `at` per unit letter plus clock forms; expected=each resolves to the current time plus its offset.
- T3.11. R-ID=R3.11; procedure=relative-at conversion against the clock; conditions=adds of `now+` offsets at a pinned process clock; expected=each stored due time equals the pinned reading plus the offset in UTC.
- T3.12. R-ID=R3.12; procedure=absolute-only storage of relative-at; conditions=an add of a scheduler/relative-at followed by list and fire; expected=the relative form appears in no stored row, tool result, or scheduler/fired-message.
- T3.13. R-ID=R3.10; procedure=relative-at malformed rejection; conditions=`at` values of any other shape; expected=each returns `invalid-at`.
- T3.14. R-ID=R3.13; procedure=command length bound; conditions=a `command` longer than SCHEDULER_MAX_COMMAND_LENGTH; expected=the add returns `command-too-long`.
- T3.15. R-ID=R3.14; procedure=name length bound; conditions=a `name` longer than SCHEDULER_MAX_NAME_LENGTH; expected=the add returns `name-too-long`.
- T4. Persistence:
- T4.1. R-ID=R4.1,R4.2; procedure=schedule-table ownership and cascade; conditions=the schedule table beside the core storage tables and a session-row delete; expected=rows live under the table-ownership rules of storage-events and the delete removes every bound scheduler/schedule.
- T4.2. R-ID=R4.3; procedure=migration registration; conditions=the generated migration pipeline of storage-events; expected=the schedule table is registered.
- T4.3. R-ID=R4.4; procedure=restart survival; conditions=a stored scheduler/schedule across a full process restart; expected=list still shows the schedule.
- T5. Permissions:
- T5.1. R-ID=R5.1; procedure=permission ask of add and remove; conditions=resolved and pending asks through the V1 ask flow; expected=each side effect begins only after the resolved ask.
- T5.2. R-ID=R5.2; procedure=deny handling; conditions=a denied ask; expected=the call fails with `permission-denied` and leaves state untouched.
- T5.3. R-ID=R5.3; procedure=list without ask; conditions=a list call; expected=no permission ask occurs.
- T5.4. R-ID=R5.4; procedure=fire without ask; conditions=a due fire of a commandless scheduler/schedule; expected=no permission ask occurs.
- T5.5. R-ID=R5.5; procedure=gate-run without ask; conditions=a due fire of a scheduler/schedule with a stored scheduler/gate-command; expected=the run performs no permission ask.
- T6. Firing and delivery:
- T6.1. R-ID=R6.3; procedure=V2 fire publish; conditions=a due fire of a V2-served session; expected=one `SessionEvent.ContextUpdated` durable event carries the scheduler/fired-message and the context epoch does not advance.
- T6.2. R-ID=R6.4; procedure=V2 admission and wake; conditions=the fire of T6.1; expected=one durable input with the same text is admitted and the execution wake follows the publish.
- T6.3. R-ID=R6.5; procedure=V1 fire delivery; conditions=a due fire of a V1-served session; expected=one synthetic user text part carries the scheduler/fired-message through the V1 prompt path.
- T6.4. R-ID=R6.6; procedure=fired-message grammar; conditions=fires of recurring, one-shot, and catch-up schedules; expected=every message follows the fixed grammar with the scheduler/scheduled-fire-time as its timestamp.
- T6.5. R-ID=R6.7; procedure=every-created schedule firing; conditions=a scheduler/schedule added from `every`; expected=the fired message carries the converted scheduler/cron-spec.
- T6.6. R-ID=R6.1,R6.2,R6.8; procedure=due-time firing and recurring advance; conditions=a stored scheduler/recurring schedule reaching its scheduler/next-due-time; expected=the fire delivers at the reached UTC due time and the row advances to the earliest match strictly after the discharged scheduler/scheduled-fire-time.
- T6.7. R-ID=R6.9; procedure=one-shot removal after fire; conditions=a delivered fire of a scheduler/one-shot; expected=the schedule is removed.
- T6.8. R-ID=R6.10; procedure=dead-session drop; conditions=a fire whose owning session row is gone; expected=the scheduler/schedule is removed and nothing is delivered.
- T6.9. R-ID=R6.12; procedure=gate before delivery side effects; conditions=a due fire with a stored scheduler/gate-command and a slow gate command; expected=no delivery side effect of that fire exists before the run exits.
- T6.10. R-ID=R6.13; procedure=gate decision; conditions=gate-runs exiting with status zero and nonzero; expected=the zero exit delivers and the nonzero exit delivers nothing.
- T6.11. R-ID=R6.14; procedure=gate-output section; conditions=zero-exit runs writing short output, over-bound output, and no output; expected=the section appends with the fixed header and trimmed output truncated to SCHEDULER_MAX_GATE_OUTPUT_LENGTH, and never appends for an outputless run.
- T6.12. R-ID=R6.15; procedure=suppressed recurring advance; conditions=a nonzero gate exit on a scheduler/recurring schedule; expected=the row advances to the earliest match strictly after the discharged scheduler/scheduled-fire-time.
- T6.13. R-ID=R6.16; procedure=suppressed one-shot removal; conditions=a nonzero gate exit on a scheduler/one-shot; expected=the schedule is removed.
- T6.14. R-ID=R6.11; procedure=commandless schedule; conditions=a scheduler/schedule added without `command`; expected=no scheduler/gate-run occurs and the fire delivers unchanged.
- T6.15. R-ID=R6.17,R6.18; procedure=gate shell and working directory; conditions=a stored gate command probing its interpreter and its working directory; expected=the run executes under the SCHEDULER_GATE_SHELL invocation with the working directory SCHEDULER_GATE_WORKING_DIRECTORY.
- T6.16. R-ID=R6.19; procedure=suppression record on nonzero exit; conditions=a gate-run exiting nonzero at a due fire; expected=exactly one diagnostic log record carries the schedule id, that exit status, and the marker SCHEDULER_SUPPRESSION_LOG_MARKER at level SCHEDULER_SUPPRESSION_LOG_LEVEL.
- T6.17. R-ID=R6.19; procedure=suppression record on spawn failure; conditions=a gate-run that fails to spawn at a due fire; expected=exactly one diagnostic log record carries the schedule id, the status SCHEDULER_GATE_SPAWN_FAILURE_EXIT_CODE, and the marker SCHEDULER_SUPPRESSION_LOG_MARKER at level SCHEDULER_SUPPRESSION_LOG_LEVEL.
- T7. Catch-up:
- T7.1. R-ID=R7.3; procedure=restart catch-up per recurring; conditions=a stored scheduler/recurring schedule with a past scheduler/next-due-time at service load; expected=exactly one scheduler/catch-up-fire delivers at the first opportunity.
- T7.2. R-ID=R7.2; procedure=catch-up marker; conditions=a delivered scheduler/catch-up-fire; expected=the scheduler/fired-message carries the literal SCHEDULER_CATCH_UP_MARKER.
- T7.3. R-ID=R7.4; procedure=catch-up advance; conditions=the delivered catch-up fire of T7.1; expected=the row advances to the earliest match strictly after the delivery time.
- T7.4. R-ID=R7.5; procedure=skipped-occurrence discharge; conditions=occurrences between the scheduler/scheduled-fire-time and the delivery time of a catch-up fire; expected=none is replayed.
- T7.5. R-ID=R7.6; procedure=missed one-shot; conditions=a scheduler/one-shot with a past due time at service load; expected=exactly one scheduler/catch-up-fire delivers and the schedule is removed.
- T7.6. R-ID=R7.1,R8.5; procedure=failed-delivery retry as catch-up; conditions=a delivery failure followed by loop retries; expected=the row stays due and each retry surfaces as a scheduler/catch-up-fire.
- T7.7. R-ID=R7.7; procedure=one gate-run per skipped series; conditions=a scheduler/schedule with a stored scheduler/gate-command whose series was skipped; expected=its scheduler/catch-up-fire performs exactly one scheduler/gate-run for the entire series.
- T7.8. R-ID=R7.8; procedure=suppressed catch-up discharge; conditions=a nonzero gate exit of the series run of T7.7; expected=the entire skipped series discharges without replay.
- T7.9. R-ID=R7.9; procedure=suppressed catch-up advance; conditions=the suppressed catch-up of T7.7 resolving at a known time; expected=the row advances to the earliest match strictly after the scheduler/gate-run resolution time.
- T7.10. R-ID=R7.1; procedure=gate-held occurrence as catch-up; conditions=a due time reached while a scheduler/gate-run of the same scheduler/schedule is in flight; expected=the held occurrence processes after the run resolves as a scheduler/catch-up-fire.
- T8. Scheduler service:
- T8.1. R-ID=R8.2,R8.4; procedure=init load and timer arming; conditions=service init with stored schedules followed by adds, removes, fires, and a reload; expected=every schedule loads, the timer arms at the earliest scheduler/next-due-time, and re-arms on each of those events.
- T8.2. R-ID=R8.3; procedure=loop serialization; conditions=concurrent scheduler/schedule mutations and fires; expected=all serialize through the single delivery loop.
- T8.3. R-ID=R6.3,R6.5; procedure=runtime routing of fires; conditions=one due fire of a V2-served session and one of a V1-served session; expected=each fire takes the delivery path of its owning session's runtime.
- T8.4. R-ID=R8.6; procedure=loop service during gate flight; conditions=a scheduler/gate-run of one scheduler/schedule in flight; expected=other scheduler/schedules mutate and fire on time.
- T8.5. R-ID=R8.7; procedure=single gate-run in flight; conditions=a long gate-run spanning later due times of its scheduler/schedule; expected=at most one scheduler/gate-run of that schedule is in flight at any time.
- T8.6. R-ID=R8.8; procedure=held due starts nothing; conditions=a due time reached during the in-flight run of T8.5; expected=no second scheduler/gate-run starts.
- T8.7. R-ID=R8.9; procedure=held due processed after resolution; conditions=the in-flight run of T8.5 resolving with status zero; expected=the held occurrence follows as a scheduler/catch-up-fire.
- T8.8. R-ID=R8.10,R8.11; procedure=suppression is not failure; conditions=a gate-command suppressing an occurrence; expected=no delivery failure is marked and nothing retries the occurrence.
- T9. Visibility:
- T9.1. R-ID=R9.1; procedure=no redelivery after displacement; conditions=a fired system message displaced from visible history; expected=nothing is re-delivered before the next due time.
- T9.2. R-ID=R9.2; procedure=ordinary retention; conditions=fired events and their projected messages under session history retention; expected=no scheduler-specific retention applies.

## Justification

- J1. Why a V2 fire both publishes a system message and admits a durable input (R6.3, R6.4): an advisory wake without pending input starts no drain, so the admitted input is the load-bearing wake; the system message records the fire in durable history with machine provenance, and carrying the same text in both keeps each self-contained when one of them leaves the visible window.
- J2. Why `every` converts to a stored cron-spec and only the cron-spec is kept (R3.3, I1): one canonical firing rule keeps storage, results, and fired messages consistent, and the echoed cron form exposes the hour-boundary restart effect of step expressions to the model at add time.
- J3. Why catch-up fires once and advances from the delivery time (R7.3, R7.4): replaying every missed occurrence after a long downtime would flood the session with redundant turns, while one marked fire preserves the information that something was missed at constant cost.
- J4. Why losing a fired system message to a later epoch replacement or compaction is acceptable (R9.1, R9.2): the fired message is a transient nudge, not durable state; the schedule row survives and fires again on its next occurrence, so the loss degrades at most one reminder.
- J5. Why an `at` in the past is rejected instead of firing immediately (R3.8): an add whose due time already passed would race the tool response with a fire the model never saw scheduled; a typed error result hands the model a correctable mistake.
- J6. Why the per-session cap and the message length bound are baked constants instead of config keys (see Configuration): the scheduler is an initial surface with no demonstrated tuning need, and fixed bounds keep the add path total on bounded input and bounded table growth.
- J7. Why the fired-message timestamp is the scheduled fire time rather than the publish time (R6.6): the timestamp identifies the discharged occurrence, stays stable across delivery retries, and makes a duplicate from the crash window of Error handling recognizable.
- J8. Why `at` accepts a scheduler/relative-at alongside `ISO 8601` datetimes (R3.10-R3.12): the model cannot be trusted to know the current wall-clock time, so an authored absolute datetime can silently land in the past or far from intent; the offset form derives the due time from the process clock at add time and removes the hallucinated-timestamp failure mode.
- J9. Why a scheduler/gate-run has no timeout (SCHEDULER_GATE_TIMEOUT, R8.6-R8.9): an event check may legitimately wait arbitrarily long, a fixed timeout would suppress fires whose event occurs just past it, and the loop isolation plus the single-flight hold already bound what an unbounded run can delay — one schedule's own occurrences.
- J10. Why a nonzero exit suppresses instead of failing the delivery (R6.15, R6.16, R7.8, R7.9, R8.10, R8.11): the gate checks an event, and not-yet is a normal answer; classifying it as a delivery failure would re-run the command on the loop's retry cadence and hot-loop a check that keeps failing.
- J11. Why the gate output rides a separate section instead of the message text (R6.14, SCHEDULER_GATE_OUTPUT_HEADER, SCHEDULER_MAX_GATE_OUTPUT_LENGTH): the stored message is model-authored and echoed by list results and fired messages alike, so embedding raw output would break the fixed grammars; a delimited, bounded section keeps every existing line intact and the output recognizable.
- J12. Why no permission ask guards the scheduler/gate-run (R5.5): the storing add already passed the `scheduler` permission ask with the command echoed in its result, and a fire-time ask would leave every occurrence of the schedule waiting on a prompt nobody may answer.
- J13. Why every suppression is logged even though not-yet is a normal answer (R6.19, SCHEDULER_SUPPRESSION_LOG_MARKER): a suppressed fire delivers nothing, so outside the diagnostic log a schedule answering not-yet is indistinguishable from a schedule that never came due and from a gate command that cannot even spawn; one record per suppression, carrying the gate outcome, closes that diagnostic gap at constant cost.
- J14. Why the scheduler/name-echo is the last fragment of the add and list lines, after the scheduler/gate-echo (R1.4, R1.5): the name is free model-authored text of up to SCHEDULER_MAX_NAME_LENGTH characters, so it may itself contain a `next due` fragment or a `sch_`-prefixed token; as the final fragment it can never precede the real `next due` fragment or the real schedule id of its line, so the first-fragment, first-token parse of the scheduler-view annotator (scheduler-view R1.3, I2) keeps working unchanged, and collapsing whitespace runs keeps every result line single-line.
- J15. Why the display name is a stored nullable column instead of reusing the message text (Schedule record, R1.4, R1.5): the message is the model-facing fire payload of up to 4096 characters, while the name is the user-facing sidebar label — short, required, and bounded at 32; a nullable column with no default keeps legacy rows valid without a backfill, and scheduler-view falls back to the message text only for those rows.

## Error handling

- All error results of the tool are final results of a failed tool call; the tool retries nothing itself, and the model may re-call with corrected arguments.
- A denied permission ask follows the V1 ask flow: the deny fails the call with `permission-denied` before any side effect, in line with the invariant that no privileged side effect precedes the resolved ask.
- An add stores its row only after argument validation and the permission ask succeed; a remove deletes only after its ask succeeds; failed calls leave no partial state.
- A delivery failure is retried by the delivery loop (R8.5); until success the schedule stays due, so the retry surfaces as a scheduler/catch-up-fire (R7.1).
- A crash between a successful delivery publish and the row advance may re-deliver the same occurrence once after restart; the repeated scheduler/scheduled-fire-time in the fired-message text makes the duplicate recognizable. This window is an accepted risk.
- A fire for a session whose row is gone drops the schedule silently, with a log line and no event (R6.10).
- A scheduler/gate-run that fails to spawn or dies to a signal counts as a nonzero exit status — SCHEDULER_GATE_SPAWN_FAILURE_EXIT_CODE for a run that failed to spawn — and suppresses its fire, writing the record of R6.19 with that outcome; the combined output of a scheduler/suppressed-fire's run is discarded.
- A scheduler/gate-run in flight is not persisted: a crash abandons the run and its output, and the restart catch-up path of R7.3 performs one fresh run for the row's unadvanced scheduler/next-due-time (R7.7).
- The delivery loop assumes single-process write ownership of the database, per the storage constraint of storage-events; concurrent processes against one database may double-fire and are out of scope.

## Dependencies

- core-session — the delivery path rides its interfaces: durable prompt admission and the serialized drain, the `SessionEvent.ContextUpdated` durable event and its projection, history selection and the epoch baseline, and the V1 runtime boundary.
- core-tools-permissions — the scheduler tool is a V1 built-in under its tool contract and registry, and gates add and remove through its session ask flow and permission matrix.
- storage-events — the schedule table follows its table-ownership and column conventions (R11, R12, R14) and registers through its generated migration pipeline (R10); fires publish through its durable publish transaction (R15-R18); the delivery loop assumes its single-writer constraint.

## Used by

- scheduler-view (R1.4, R1.5) — its annotator parses the add and list success text as its input contract; its schedule-list endpoint reuses the schedule record fields and the scheduler/service as its list source.
- tool-task (R2.3) — cites the single-delivery-loop property (R8.3) as the process-topology precondition of its completion-message delivery; no scheduler behavior changes there.
