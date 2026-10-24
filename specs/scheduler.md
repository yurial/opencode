# Scheduler Tool

Status: draft
Reference: scheduler
Spec source of truth for: the AI-facing scheduler — the `scheduler` tool (actions add, remove, list), session-bound persisted schedules, the interval, cron, and one-shot time-spec inputs, fire delivery into sessions served by the V2 and the V1 runtime, missed-fire catch-up, permission gating, and the process-global scheduler service with its single delivery loop.

## Overview

The scheduler lets the model running inside a session schedule future events for itself. A scheduler/schedule carries a firing rule and a message text; at each due time the scheduler/service delivers a scheduler/fired-message into the owning session, and the model sees it and continues work (R6). Schedules are created and managed through the `scheduler` tool (R1), are bound to the creating session (R2), and persist in the schedule table across process restarts (R4). Adding and removing asks the `scheduler` permission through the V1 ask flow (R5); firing itself is not a tool call and asks nothing.

The scheduler ships no HTTP surface: no protocol group, no handler, and no SDK regeneration belong to it; the server-api-sdk boundary stays untouched.

Fired messages are transient nudges, not durable state. The schedule row is the durable artifact; a fired message displaced from visible history by a later epoch replacement or compaction is never re-delivered (R9). History filtering of discarded assistant and user parts never touches a fired system message, because system messages are not eligible filtering parts. Schedule state lives in a table, not in the event log, so event-log pruning never removes a schedule.

## Scope

In:

- The `scheduler` tool surface: actions add, remove, list; argument domains; success and error result contracts.
- Schedule spec inputs: interval (`every`), cron expression (`cron`), one-shot datetime (`at`); conversion, validation, and storage rules.
- Session binding of schedules and cascade removal on session deletion.
- Fire delivery into sessions served by the V2 runtime and by the V1 runtime; the fired-message grammar.
- Missed-fire catch-up semantics for recurring and one-shot schedules.
- Persistence: the schedule table, its migration registration, restart survival.
- Permission gating of add and remove.
- The scheduler service: process-global layer node, init reload, single delivery loop.

Out (non-goals):

- Any HTTP API, protocol group, handler, or SDK surface for schedules.
- Schedules not bound to a session: global, cross-session, or user-facing reminders.
- Local-timezone or daylight-saving-aware recurring schedules; all due-time evaluation is UTC.
- Multi-process schedule ownership: concurrent processes writing one database, beyond the single-writer constraint the loop inherits from storage-events.
- Calendar semantics beyond standard cron: holiday skipping, natural-language dates, reminder UX.

## Definitions

- **scheduler/schedule**: a persisted record binding a firing rule and a message text to the session whose tool call created it; identified by a `sch_`-prefixed id.
- **scheduler/cron-spec**: the standard five-field cron expression that is the canonical stored firing rule of a recurring scheduler/schedule.
- **scheduler/one-shot**: a scheduler/schedule created from a datetime that fires exactly once at that time and is removed by its fire.
- **scheduler/recurring**: a scheduler/schedule whose firing rule is a scheduler/cron-spec; it fires at every match and survives each fire until removed.
- **scheduler/next-due-time**: the stored UTC timestamp at which a scheduler/schedule is next to fire (the `next_fire_at` column).
- **scheduler/fire**: the delivery of a scheduler/schedule message into its owning session at a reached due time: the durable publish plus the prompt admission of the scheduler/fired-message.
- **scheduler/scheduled-fire-time**: the UTC time of the occurrence a scheduler/fire discharges; equal to the scheduler/next-due-time when the fire is initiated.
- **scheduler/catch-up-fire**: a scheduler/fire delivered after its scheduler/scheduled-fire-time because the due time passed while the process was down or an earlier delivery attempt failed; discharges every skipped occurrence of a scheduler/recurring schedule at once.
- **scheduler/fired-message**: the message text delivered by a scheduler/fire, following the fixed grammar of the Interface section, with the catch-up marker appended for a scheduler/catch-up-fire.
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
| `at` | add, optional | ISO 8601 datetime, naive or zoned |
| `id` | remove | schedule id |

`every`, `cron`, and `at` are mutually exclusive; an add carries exactly one of them. `list` takes no further arguments.

Success results (model-facing text):

- add: echoes the schedule id, the spec form (the stored scheduler/cron-spec, or the stored UTC datetime of a scheduler/one-shot), and the scheduler/next-due-time in UTC.
- list: one line per scheduler/schedule of the calling session, each carrying the schedule id, the spec form, the scheduler/next-due-time in UTC, and the message text; no schedules yields an empty listing.
- remove: confirms the removed schedule id.

Error results (the complete set; semantics in Error handling):

| Error result | Meaning |
|---|---|
| `invalid-arguments` | args fail schema decode: wrong types, missing `id`, unknown action (R1.3) |
| `schedule-spec-conflict` | add carries zero or more than one of `every`, `cron`, `at` (R3.1) |
| `invalid-interval` | `every` is malformed (R3.2) |
| `invalid-cron` | `cron` is malformed (R3.4) |
| `cron-without-future-match` | `cron` has no future match (R3.5) |
| `invalid-at` | `at` is unparseable as an ISO 8601 datetime (R3.6) |
| `at-in-past` | `at` resolves to a time not after the current time (R3.8) |
| `message-too-long` | `message` is longer than SCHEDULER_MAX_MESSAGE_LENGTH (R3.9) |
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
| `next_fire_at` | UTC timestamp, integer epoch milliseconds | stored scheduler/next-due-time |
| `created_at`, `updated_at` | timestamps | shared timestamp columns |

Exactly one of `cron` and `at` is non-null per row.

### Fired-message grammar

```
<scheduled-fire-time> fired schedule id <id> <spec>: <message><catch-up-marker>
```

- `<scheduled-fire-time>`: the scheduler/scheduled-fire-time, UTC, ISO 8601.
- `<id>`: the schedule id.
- `<spec>`: the scheduler/cron-spec of a scheduler/recurring schedule, or the stored UTC datetime of a scheduler/one-shot.
- `<message>`: the stored message text.
- `<catch-up-marker>`: present only on a scheduler/catch-up-fire; the literal fixed by SCHEDULER_CATCH_UP_MARKER in Configuration.

### Permission ask

Add and remove ask through the V1 permission flow under the permission name `scheduler`; the pattern set of an add ask is the spec form, the pattern set of a remove ask is the schedule id; list asks nothing (R5).

### Delivery boundary

A fire of a session served by the V2 runtime: one `SessionEvent.ContextUpdated` durable event carrying the scheduler/fired-message with no context-epoch advance, one admitted durable input carrying the same text, and one execution wake (R6.3, R6.4). A fire of a session served by the V1 runtime: one synthetic user text part carrying the scheduler/fired-message, admitted through the V1 prompt path (R6.5).

## Configuration

| Name | Allowed values | Default | Effect |
|---|---|---|---|
| SCHEDULER_MAX_SCHEDULES_PER_SESSION | `fixed` 50 schedules | — | Per-session add cap; an add that would exceed it returns `schedule-cap-reached` (R2.4) |
| SCHEDULER_MAX_MESSAGE_LENGTH | `fixed` 4096 characters | — | Message length bound; a longer `message` returns `message-too-long` (R3.9) |
| SCHEDULER_CATCH_UP_MARKER | `fixed` the literal ` [catch-up: delivered after the scheduled fire time]` | — | Text appended to the scheduler/fired-message of a scheduler/catch-up-fire (R7.2) |

## Requirements

- R1. Tool surface:
- R1.1. The scheduler tool is a V1 built-in registered in the V1 tool registry and defined under the V1 tool contract.
- R1.2. The tool selects one of the actions add, remove, and list through its `action` argument.
- R1.3. Args that fail schema decode return the `invalid-arguments` error result.
- R1.4. An add result echoes the schedule id, the spec form, and the scheduler/next-due-time in UTC.
- R1.5. A list result carries one line per scheduler/schedule of the calling session, each with the schedule id, the spec form, the scheduler/next-due-time in UTC, and the message text.
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
- R3.6. An `at` value is an ISO 8601 datetime; an unparseable value returns `invalid-at`.
- R3.7. A naive `at` resolves in the process timezone at add time into UTC, and a zoned `at` resolves into the UTC equivalent of its offset.
- R3.8. An `at` that resolves to a time not after the current time returns `at-in-past`.
- R3.9. A `message` longer than SCHEDULER_MAX_MESSAGE_LENGTH returns `message-too-long`.
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
- R7. Missed-fire catch-up:
- R7.1. A fire is a scheduler/catch-up-fire when its scheduler/scheduled-fire-time precedes the load of the scheduler/service in the current process, or when it retries a previously failed delivery.
- R7.2. A scheduler/catch-up-fire appends the catch-up marker to the scheduler/fired-message.
- R7.3. At scheduler/service load, every scheduler/recurring schedule with a past scheduler/next-due-time receives exactly one scheduler/catch-up-fire at the first opportunity.
- R7.4. After a scheduler/catch-up-fire of a scheduler/recurring schedule, the scheduler/next-due-time advances to the earliest match strictly after the delivery time.
- R7.5. Occurrences skipped between the scheduler/scheduled-fire-time and the delivery time of a scheduler/catch-up-fire are never replayed.
- R7.6. At scheduler/service load, a scheduler/one-shot with a past due time receives exactly one scheduler/catch-up-fire and is then removed.
- R8. Scheduler service:
- R8.1. The scheduler/service is a process-global layer node bound in the host application-services graph.
- R8.2. At init the scheduler/service loads every persisted scheduler/schedule, arms its timer, and starts its delivery loop.
- R8.3. All scheduler/schedule mutations and fire deliveries of one process serialize through the single delivery loop of the scheduler/service.
- R8.4. The delivery-loop timer arms at the earliest scheduler/next-due-time among stored schedules and re-arms on every add, remove, fire, and reload.
- R8.5. A fire whose delivery fails is retried by the delivery loop, and its scheduler/schedule is neither advanced nor removed until a delivery succeeds.
- R9. Visibility limits:
- R9.1. The scheduler never re-delivers a scheduler/fired-message that a later epoch replacement or compaction displaced from visible history.
- R9.2. Fired events and their projected messages receive no scheduler-specific retention and follow ordinary session history and event-log retention.

## Implementation

- I1. An `every` value of n with unit `m` converts to `*/n * * * *`, with unit `h` to `0 */n * * *`, and with unit `d` to `0 0 */n * *`, where n is the positive integer prefix of the value.
- I2. Cron evaluation uses a standard five-field matcher over the UTC clock; the next due time of an instant is the earliest match strictly after it; daylight-saving arithmetic never applies.
- I3. The schedule table lives with the core storage tables, carries a cascading foreign key to the session table, an index on `next_fire_at` for the due-time scan, and an index on `session_id` for list and cascade.
- I4. The scheduler/service depends on the database, the durable event publish path, the session execution service, the session store, and the V1 prompt admission path; hosts bind it in the application-services graph like the other process-global service nodes.
- I5. The V2 admission of a fire uses the admit-only form of the session prompt interface, and the delivery loop issues the execution wake itself after the event publish.
- I6. The delivery loop is the sole writer of schedule rows: it applies tool add and remove requests, and a fire publishes, admits, and only then advances or removes the row.
- I7. At fire time the scheduler/service resolves the owning runtime of the session and routes the delivery to the V2 or the V1 path.

## Examples

- E1. R1 subtree: `action: "add", every: "30m", message: "check CI status"` returns the new schedule id, the spec form `*/30 * * * *`, and the next due time, for example `2026-10-24T13:00:00Z`.
- E2. R2 subtree: session A adds a schedule; session B lists and sees none of it; session B removes A's id and receives `schedule-not-found`.
- E3. R3 subtree: conversion and validation examples follow per requirement.
- E3.2. `every: "45m"` converts to `*/45 * * * *`, which fires at minute 0 and minute 45 of every hour under standard cron restart; the add result shows the cron form, so the model sees the effective rule.
- E3.4. `cron: "0 0 30 2 *"` (minute zero, hour zero, day thirty, February) has no future match and returns `cron-without-future-match`.
- E3.7. In a process running at offset `+03:00`, a naive `at: "2026-11-02T09:00:00"` and a zoned `at: "2026-11-02T09:00:00+03:00"` both store the due time `2026-11-02T06:00:00Z`.
- E3.8. `at: "2020-01-01T00:00:00Z"` returns `at-in-past`.
- E4. R4 subtree: after a full process restart, list still shows the schedule; deleting the session makes it disappear from the table.
- E5. R5 subtree: a denied add returns `permission-denied` and no row appears in list; a list runs without any ask.
- E6. R6 subtree: fired-message examples follow.
- E6.6. A `*/30 * * * *` schedule with message `check CI status` fires the message `2026-10-24T13:00:00Z fired schedule id sch_example */30 * * * *: check CI status`.
- E6.7. An add of `every: "1d"` fires with the spec `0 0 * * *` in the message text.
- E7. R7 subtree: a `0 * * * *` schedule due at 13:00 with the process down until 15:37 delivers one catch-up fire at 15:37 with timestamp `2026-10-24T13:00:00Z` and the catch-up marker; the next due time becomes 16:00; the skipped occurrences 14:00 and 15:00 are never replayed.
- E7.6. A one-shot due at 13:00 with the process down until 15:37 fires once at 15:37 with the catch-up marker and is then removed.
- E8. R8 subtree: with a `*/15 * * * *` schedule and a `0 0 * * *` schedule stored, the timer wakes at the nearer due time and re-arms after each fire.
- E9. R9 subtree: after a compaction displaces an old fired system message from visible history, the scheduler sends nothing new before the next due time.

## Tests

- T1. Tool surface:
- T1.1. registry-exposes-scheduler-tool (R1.1, R1.2)
- T1.2. decode-failure-returns-invalid-arguments (R1.3)
- T1.3. add-result-echoes-id-spec-next-due (R1.4, R3.3)
- T1.4. list-lines-carry-id-spec-next-message (R1.5)
- T1.5. remove-confirms-id (R1.6)
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
- T4. Persistence:
- T4.1. schedule-table-owns-rows-with-cascade (R4.1, R4.2, I3)
- T4.2. migration-registers-table (R4.3)
- T4.3. schedules-survive-restart (R4.4)
- T5. Permissions:
- T5.1. add-and-remove-ask-scheduler-permission (R5.1)
- T5.2. deny-leaves-state-untouched (R5.2)
- T5.3. list-asks-nothing (R5.3)
- T5.4. fire-asks-nothing (R5.4)
- T6. Firing and delivery:
- T6.1. v2-fire-publishes-context-updated-without-epoch-advance (R6.3)
- T6.2. v2-fire-admits-input-and-wakes-execution (R6.4, I5)
- T6.3. v1-fire-delivers-synthetic-user-part (R6.5)
- T6.4. fired-message-follows-grammar (R6.6)
- T6.5. every-created-schedule-fires-cron-form (R6.7)
- T6.6. recurring-advances-from-discharged-time (R6.1, R6.8, I2)
- T6.7. one-shot-removed-after-fire (R6.9)
- T6.8. dead-session-drops-schedule (R6.10)
- T7. Catch-up:
- T7.1. restart-delivers-one-catch-up-per-recurring (R7.3)
- T7.2. catch-up-carries-marker (R7.2)
- T7.3. catch-up-advances-from-delivery-time (R7.4)
- T7.4. skipped-occurrences-not-replayed (R7.5)
- T7.5. missed-one-shot-fires-then-removed (R7.6)
- T7.6. failed-delivery-retry-is-catch-up (R7.1, R8.5)
- T8. Scheduler service:
- T8.1. init-loads-schedules-and-arms-timer (R8.2, R8.4, I5)
- T8.2. mutations-serialize-through-loop (R8.3, I6)
- T8.3. routing-selects-runtime-path (I7)
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

## Error handling

- All error results of the tool are final results of a failed tool call; the tool retries nothing itself, and the model may re-call with corrected arguments.
- A denied permission ask follows the V1 ask flow: the deny fails the call with `permission-denied` before any side effect, in line with the invariant that no privileged side effect precedes the resolved ask.
- An add stores its row only after argument validation and the permission ask succeed; a remove deletes only after its ask succeeds; failed calls leave no partial state.
- A delivery failure is retried by the delivery loop (R8.5); until success the schedule stays due, so the retry surfaces as a scheduler/catch-up-fire (R7.1).
- A crash between a successful delivery publish and the row advance may re-deliver the same occurrence once after restart; the repeated scheduler/scheduled-fire-time in the fired-message text makes the duplicate recognizable. This window is an accepted risk.
- A fire for a session whose row is gone drops the schedule silently, with a log line and no event (R6.10).
- The delivery loop assumes single-process write ownership of the database, per the storage constraint of storage-events; concurrent processes against one database may double-fire and are out of scope.

## Dependencies

- core-session — the delivery path rides its interfaces: durable prompt admission and the serialized drain, the `SessionEvent.ContextUpdated` durable event and its projection, history selection and the epoch baseline, and the V1 runtime boundary.
- core-tools-permissions — the scheduler tool is a V1 built-in under its tool contract and registry, and gates add and remove through its session ask flow and permission matrix.
- storage-events — the schedule table follows its table-ownership and column conventions (R11, R12, R14) and registers through its generated migration pipeline (R10); fires publish through its durable publish transaction (R15-R18); the delivery loop assumes its single-writer constraint.

## Used by

None. No other spec currently cites this reference.
