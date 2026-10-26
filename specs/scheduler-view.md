# Scheduler View

Status: draft
Reference: scheduler-view
Spec source of truth for: the schedule visibility layer over the scheduler — the ETA annotator of scheduler tool results, the read-only session schedule-list HTTP endpoint, and the TUI sidebar schedules block.

## Overview

The scheduler surfaces absolute UTC instants only: the tool result text of scheduler R1.4 and R1.5, the fired messages, and the stored rows all carry `next due` times without any human-relative form, and no HTTP or TUI surface shows the schedules of a session at a glance. This spec adds a display layer on top of the scheduler with three always-on builtin parts and no new config keys: the scheduler-view/annotator, a host plugin that appends scheduler-view/annotation-line entries with a relative ETA and the absolute time to the output text of completed scheduler tool results (R1); the scheduler-view/schedule-list-endpoint, a read-only GET route exposing the schedules of one session to clients (R3); and the scheduler-view/sidebar-block, a TUI feature plugin that renders the current session's schedules in the sidebar with the same ETA grammar (R4). The ETA grammar itself is shared by the annotator and the sidebar block (R2).

The layer owns no schedule state and mutates nothing: every part derives its data from scheduler surfaces — the annotator from the tool result text, the endpoint and the sidebar from the stored scheduler/schedule rows through the scheduler/service. The scheduler core keeps no HTTP surface of its own; the read-only schedule-list route is owned by this spec, and the scheduler contributes to it only as the data source (see the Used by entry of scheduler).

## Scope

In: the annotator plugin — its registration, its hook filter, its append-only output contract, and the annotation-line grammar; the ETA grammar shared by the annotator and the sidebar block; the schedule-list endpoint — route, path parameter, response schema, ordering, and error results; the sidebar block — registration, slot, data fetch, entry rendering, refresh triggers, timer cleanup, and degradation.

Out (non-goals): any schedule mutation surface — HTTP writes, schedule management commands, or permission asks on the view layer; new scheduler domain events on the event bus; changes to the scheduler tool core, its result title, its metadata, its permission asks, or its result contracts; new config keys or theme elements; TUI state-store accessors for schedules; localization of the ETA grammar beyond the fixed English forms.

## Definitions

- **scheduler-view/annotator**: the always-on builtin host plugin that appends scheduler-view/annotation-line entries, each with a scheduler-view/eta and the absolute UTC time, to the output text of completed scheduler tool results.
- **scheduler-view/annotation-line**: the single line the annotator appends to a completed scheduler tool result for the scheduler/schedule named in the same output line as the first `next due <instant>` fragment of that line, carrying the `sch_`-prefixed schedule id, the scheduler-view/eta, and the absolute UTC time, per the grammar of the Interface section.
- **scheduler-view/eta**: the relative time-to-fire text of one schedule, derived from its scheduler/next-due-time minus the scheduler-view/eta-clock, following the ETA grammar of the Interface section.
- **scheduler-view/eta-clock**: the UTC clock of the process rendering a scheduler-view/eta — the server host process for the annotator, the TUI process for the sidebar block.
- **scheduler-view/schedule-list-endpoint**: the read-only GET route that returns the scheduler-view/schedule-entry list of one session, ordered by next fire time.
- **scheduler-view/schedule-entry**: one element of the schedule-list endpoint response — the id, spec, message, nextFireAt, and command of one scheduler/schedule.
- **scheduler-view/sidebar-block**: the always-on builtin TUI feature plugin that renders the current session's schedules in the `sidebar_content` slot, one entry line per scheduler-view/schedule-entry.

## Interface

### Annotator

- Registration: a builtin host plugin returned by the internal-plugins list of the server host process; the plugin enables and disables together with the other internal plugins, and no separate config key exists.
- Hook: `tool.execute.after`, acting only on completed calls whose tool name is `scheduler`; the annotator appends to the output text of the passed result and changes nothing else.
- Annotation-line grammar:

```
eta <id>: <eta> (<absolute>)
```

- `<id>`: the `sch_`-prefixed schedule id named in the same line as the first `next due` fragment of that line.
- `<eta>`: the scheduler-view/eta of that schedule at annotation time.
- `<absolute>`: the scheduler/next-due-time in the ISO 8601 UTC form of second precision (`YYYY-MM-DDTHH:MM:SSZ`).

### ETA grammar

```
<eta> := now
       | in <seconds>s
       | in <hours>h <minutes>m
```

- The remainder is the scheduler/next-due-time minus the scheduler-view/eta-clock at render time.
- A remainder at or below zero selects `now`.
- A remainder above zero and below one minute selects the seconds production; the seconds value is the floored whole seconds of the remainder, without a leading zero.
- A remainder of one minute or more selects the hour-minute production; the hours value is the floored whole hours of the remainder, without a leading zero and without an upper bound, and the minutes value is the whole minutes of the remainder below one hour, as two digits with a leading zero.

### Schedule-list endpoint

- `GET /api/session/:sessionID/schedule` — endpoint id `session.schedule.list` in the `server.session` group, OpenAPI identifier `v2.session.schedule.list`; Location resolves from the session row of the path session id; no query parameters and no request payload.
- Success body — the data envelope of session routes, one schedule-entry per schedule of the session:

```json
{"data":{"schedules":[{"id":"sch_once","spec":{"at":1792937100000},"message":"deploy check","nextFireAt":1792937100000,"command":null},{"id":"sch_rel","spec":{"cron":"0 0 * * *"},"message":"daily digest","nextFireAt":1792972800000,"command":"test -f /repo/done.flag"}]}}
```

- schedule-entry fields: `id` — string, the `sch_`-prefixed schedule id; `spec` — `{"cron": string}` for a scheduler/recurring schedule or `{"at": integer}` for a scheduler/one-shot, the integer being UTC epoch milliseconds; `message` — string, the stored message text; `nextFireAt` — integer, the scheduler/next-due-time (schedule-record column `next_fire_at`) as UTC epoch milliseconds; `command` — string or null, the stored scheduler/gate-command text, null when the scheduler/schedule stores none.
- Error results (the complete set; semantics in Error handling):

| Error result | HTTP status |
|---|---|
| `InvalidRequestError` | HTTP 400 |
| `UnauthorizedError` | HTTP 401 |
| `SessionNotFoundError` | HTTP 404 |
| `UnknownError` | HTTP 500 |

### Sidebar block

- Registration: builtin TUI feature plugin id `internal:sidebar-scheduler`, registered with the built-in feature plugins; slot `sidebar_content` at order SCHEDULER_VIEW_SIDEBAR_SLOT_ORDER; no plugin-config key.
- Data: fetch through the SDK client of the TUI plugin api against the schedule-list endpoint, with the session id of the slot.
- Block rendering: the header line `Schedules`, then one entry line per schedule-entry of the last successful response:

```
<eta> (<absolute>) <id><gate-marker> (<spec>): <message>
```

- `<eta>` and `<absolute>`: the same productions as the annotation line; the scheduler-view/eta-clock is the UTC clock of the TUI process.
- `<gate-marker>`: the literal of SCHEDULER_VIEW_SIDEBAR_GATE_MARKER, appended directly after the schedule id, present only on an entry whose `command` is non-null; it never consumes the shortened-message budget.
- `<spec>`: the cron string of a scheduler/recurring schedule, or the absolute UTC time of a scheduler/one-shot.
- `<message>`: the shortened message — whitespace runs collapsed to single spaces, truncated to SCHEDULER_VIEW_SIDEBAR_MESSAGE_MAX UTF-16 code units with an ellipsis character appended when truncation occurs.

## Configuration

| Name | Allowed values | Default | Effect |
|---|---|---|---|
| SCHEDULER_VIEW_SIDEBAR_SLOT_ORDER | `fixed` 450 | — | `sidebar_content` slot order of the scheduler-view/sidebar-block (R4.2) |
| SCHEDULER_VIEW_SIDEBAR_REFRESH_INTERVAL | `fixed` 30000 ms | — | Periodic refetch period of the sidebar block; every expiry refetches the schedule list and re-renders (R4.10) |
| SCHEDULER_VIEW_SIDEBAR_MESSAGE_MAX | `fixed` 60 UTF-16 code units | — | Length bound of the shortened message of a sidebar entry line, counted and cut in UTF-16 code units (R4.6) |
| SCHEDULER_VIEW_SIDEBAR_GATE_MARKER | `fixed` the literal `*` | — | Gate-command indicator appended directly after the schedule id of a sidebar entry line whose schedule-entry carries a non-null `command` (R4.4) |

## Requirements

- R1. Annotator:
- R1.1. The scheduler-view/annotator is a builtin host plugin that registers with the internal plugins of the server host process and enables and disables together with the other internal plugins.
- R1.2. The annotator runs its annotation pass on every completed call of the scheduler tool, over the add, list, and remove actions alike.
- R1.3. For every line of the output text of a completed scheduler tool result that carries a `next due <instant>` fragment, the annotator appends exactly one scheduler-view/annotation-line, derived from the first such fragment of that line. A `next due <instant>` fragment other than the first of its line names no schedule and receives no annotation.
- R1.4. The annotator appends the scheduler-view/annotation-line entries after the tool's own output text, in the order their schedules appear in that text.
- R1.5. The annotator changes no line of the tool's own output text and leaves the result title and the result metadata unchanged.
- R1.6. The scheduler-view/eta-clock of the annotator is the UTC clock of the server host process at annotation time.
- R1.7. The annotator reads due instants exclusively from the output text of the completed result and queries no scheduler/service and no schedule storage.
- R1.8. A completed result whose output text carries no `next due <instant>` fragment receives no annotation line.
- R1.9. A failure inside the annotator leaves the completed result exactly as the scheduler tool produced it.
- R2. ETA grammar:
- R2.1. A scheduler-view/eta is derived from the remainder of the scheduler/next-due-time minus the scheduler-view/eta-clock at render time.
- R2.2. A remainder at or below zero renders as `now`.
- R2.3. A remainder above zero and below one minute renders as the seconds production of the ETA grammar.
- R2.4. A remainder of one minute or more renders as the hour-minute production of the ETA grammar.
- R2.5. The absolute time of a scheduler-view/annotation-line and of a sidebar entry line is the scheduler/next-due-time in the ISO 8601 UTC form of second precision.
- R3. Schedule-list endpoint:
- R3.1. The scheduler-view/schedule-list-endpoint answers read-only GET requests with the schedules of the session named by the path parameter.
- R3.2. The success response carries one scheduler-view/schedule-entry for every scheduler/schedule bound to that session, each with the fields `id`, `spec`, `message`, `nextFireAt`, and `command`.
- R3.3. The success response orders the entries by `nextFireAt` ascending, and entries with an equal `nextFireAt` by `id` ascending.
- R3.4. Every `nextFireAt` value is the scheduler/next-due-time of the entry's schedule as an integer number of UTC epoch milliseconds.
- R3.5. The endpoint mutates no scheduler/schedule and performs no permission ask.
- R3.6. A request whose path session id resolves to no stored session fails with `SessionNotFoundError`.
- R3.7. A request whose path session id fails to decode fails with `InvalidRequestError`.
- R4. Sidebar block:
- R4.1. The scheduler-view/sidebar-block is a builtin TUI feature plugin registered with the built-in feature plugins, with no plugin-config key of its own.
- R4.2. The scheduler-view/sidebar-block registers in the `sidebar_content` slot at order SCHEDULER_VIEW_SIDEBAR_SLOT_ORDER.
- R4.3. The scheduler-view/sidebar-block reads its data only through the SDK client of the TUI plugin api against the scheduler-view/schedule-list-endpoint of the current session and never imports backend scheduler implementation modules.
- R4.4. The sidebar block renders one entry line per scheduler-view/schedule-entry of the last successful response, each line carrying the schedule id, the scheduler-view/eta, the absolute time, the spec form, and the shortened message. A line of an entry with a non-null `command` appends SCHEDULER_VIEW_SIDEBAR_GATE_MARKER directly after its schedule id.
- R4.5. The spec form of an entry line is the cron string of a scheduler/recurring schedule and the absolute time of a scheduler/one-shot.
- R4.6. The shortened message of an entry line collapses every whitespace run to a single space and truncates the text to SCHEDULER_VIEW_SIDEBAR_MESSAGE_MAX UTF-16 code units, appending an ellipsis character when truncation occurs. A truncation boundary that falls inside a surrogate pair leaves the lone leading surrogate as the final code unit of the shortened message, before the appended ellipsis.
- R4.7. The sidebar block renders the header line `Schedules` above its entry lines, and the whole block renders nothing while the response carries no schedule entry.
- R4.8. The sidebar block refetches the schedule list when the current session changes.
- R4.9. The sidebar block refetches the schedule list when a scheduler tool part is observed in the current session.
- R4.10. The sidebar block refetches the schedule list on every expiry of SCHEDULER_VIEW_SIDEBAR_REFRESH_INTERVAL.
- R4.11. The sidebar block clears its interval timer on disposal through the TUI plugin lifecycle.
- R4.12. The scheduler-view/eta-clock of the sidebar block is the UTC clock of the TUI process at render time.
- R4.13. A failed fetch leaves the entries of the last successful response rendered, and a fetch that fails before any success renders the block as for an empty response.
- R4.14. A fetch or render failure of the sidebar block never crashes the session screen or the TUI process.

## Implementation

- I1. The annotator implements its pass as a `tool.execute.after` hook of the host-plugin contract, filters on the tool name `scheduler`, and appends to the output text of the passed result object in place.
- I2. The annotator extracts, from every line of the output text that carries the fragment `next due`, the schedule id as the first `sch_`-prefixed token of the line and the due instant as the token that follows the first such fragment of the line.
- I3. The schedule-list endpoint lists the schedules of the path session through the scheduler/service of the hosting process and maps every entry to the response fields of the Interface.
- I4. The schedule-list route resolves the request Location from the session row through the session-location middleware of the server stack, so the path session id alone addresses the route.
- I5. The sidebar block runs its periodic refetch on an interval timer of the TUI process and clears the timer through the disposal callback of the TUI plugin lifecycle.
- I6. The sidebar block observes scheduler tool parts through the session data of the TUI plugin api and treats every newly observed scheduler tool part of the current session as a refetch trigger.
- I7. The ETA grammar has two renderers, the annotator of the server host process and the sidebar block of the TUI package; both follow the grammar of this spec, and neither imports the other.

## Examples

- E1. R1 subtree: annotator input and output strings follow; the input line is the tool's own output text, the output is the same text plus the appended annotation lines.
- E1.3. Add: input text `Scheduled sch_fix (*/30 * * * *), next due 2026-10-25T14:05:00Z` with eta-clock `2026-10-25T12:00:00Z` becomes the same line followed by `eta sch_fix: in 2h 05m (2026-10-25T14:05:00Z)`. List line with a literal fragment in the message: `sch_fix (*/30 * * * *) next due 2026-10-25T14:05:00Z: ping next due 2026-10-25T20:05:00Z folks` gains exactly one annotation line, `eta sch_fix: in 2h 05m (2026-10-25T14:05:00Z)`, from the first fragment; the fragment inside the message text names no schedule. The same holds for the gate echo of scheduler R1.4 and R1.5: an add line ending in `[gate: echo next due 2020-01-01T00:00:00Z]` still gains exactly one annotation from the real first fragment, and a `next due` occurrence inside the echoed command text names no schedule.
- E1.4. List: input text `sch_fix (*/30 * * * *) next due 2026-10-25T14:05:00Z: check CI status\nsch_rel (0 0 * * *) next due 2026-10-26T00:00:00Z: daily digest` with eta-clock `2026-10-25T12:00:00Z` gains two lines appended after the listing: `eta sch_fix: in 2h 05m (2026-10-25T14:05:00Z)` and `eta sch_rel: in 12h 00m (2026-10-26T00:00:00Z)`.
- E1.8. Remove: `Removed schedule sch_fix` carries no next-due fragment and stays unchanged; a list result with no schedules stays an empty listing.
- E2. R2 subtree: with eta-clock `2026-10-25T12:00:00Z`, next-due `2026-10-25T14:05:00Z` renders `in 2h 05m`, `2026-10-25T12:05:30Z` renders `in 0h 05m`, `2026-10-25T12:00:45.9Z` renders `in 45s`, `2026-10-25T12:00:00Z` renders `now`, the overdue `2026-10-25T11:50:00Z` renders `now`, and the day-crossing `2026-10-27T14:00:00Z` renders `in 50h 00m`.
- E3. R3 subtree: `GET /api/session/ses_work/schedule` returns the success body of the Interface; the one-shot entry precedes the cron entry by its earlier nextFireAt.
- E3.3. Two entries with nextFireAt values of the same instant order by id ascending, so `sch_a` precedes `sch_b`.
- E3.6. `GET /api/session/ses_missing/schedule` fails with `SessionNotFoundError` and changes no state.
- E4. R4 subtree: with the two-entry response above and TUI clock `2026-10-25T12:00:00Z`, the block renders the header `Schedules` and the entry line `in 2h 05m (2026-10-25T14:05:00Z) sch_once (2026-10-25T14:05:00Z): deploy check` followed by `in 12h 00m (2026-10-26T00:00:00Z) sch_rel (0 0 * * *): daily digest`.
- E4.4. A third entry `sch_gate` with a non-null `command` and message `standup prep` at the same due time as `sch_rel` renders `in 12h 00m (2026-10-26T00:00:00Z) sch_gate* (0 9 * * 1): standup prep`; an entry with a null `command` renders no marker.
- E4.6. A message of one hundred `a` code units renders as its first sixty code units followed by the ellipsis character; a message of fifty-nine `a` code units followed by one emoji renders as the fifty-nine `a` code units, the lone leading surrogate of the emoji, and the ellipsis character; a message containing a newline renders the newline as a single space.
- E4.13. A refetch that fails after the successful render above leaves both entry lines on screen unchanged.

## Tests

- T1. Annotator:
- T1.1. annotator-registers-with-internal-plugins (R1.1)
- T1.2. annotator-runs-on-every-action (R1.2)
- T1.3. add-result-gains-one-annotation-line (R1.3)
- T1.4. list-result-gains-line-per-schedule-in-order (R1.3, R1.4)
- T1.5. annotation-leaves-title-and-metadata-unchanged (R1.5)
- T1.6. annotator-eta-uses-host-clock (R1.6)
- T1.7. annotator-reads-no-scheduler-service (R1.7, I2)
- T1.8. remove-and-error-results-unchanged (R1.8)
- T1.9. annotator-failure-leaves-result-intact (R1.9)
- T2. ETA grammar:
- T2.1. eta-now-at-and-past-due (R2.2)
- T2.2. eta-seconds-below-minute (R2.3)
- T2.3. eta-hour-minute-production (R2.4)
- T2.4. eta-and-absolute-derive-from-next-due-and-clock (R2.1, R2.5)
- T3. Endpoint:
- T3.1. endpoint-returns-session-schedules (R3.1, R3.2)
- T3.2. endpoint-orders-by-next-fire-then-id (R3.3)
- T3.3. next-fire-at-is-epoch-milliseconds (R3.4)
- T3.4. endpoint-mutates-and-asks-nothing (R3.5)
- T3.5. unknown-session-not-found (R3.6)
- T3.6. undecodable-session-invalid-request (R3.7)
- T3.7. endpoint-lists-through-scheduler-service (I3)
- T3.8. endpoint-returns-command-field (R3.2)
- T4. Sidebar block:
- T4.1. sidebar-registers-builtin-in-slot-order (R4.1, R4.2)
- T4.2. sidebar-fetches-via-sdk-client-only (R4.3)
- T4.3. sidebar-renders-entry-lines (R4.4, R4.5)
- T4.4. sidebar-shortens-messages (R4.6)
- T4.5. sidebar-empty-renders-nothing (R4.7)
- T4.6. sidebar-refetch-on-session-change (R4.8)
- T4.7. sidebar-refetch-on-scheduler-part (R4.9, I6)
- T4.8. sidebar-refetch-on-interval (R4.10)
- T4.9. sidebar-clears-timer-on-dispose (R4.11, I5)
- T4.10. sidebar-eta-uses-tui-clock (R4.12)
- T4.11. sidebar-keeps-last-data-on-failure (R4.13)
- T4.12. sidebar-failure-never-crashes (R4.14)
- T4.13. sidebar-marks-gate-entries (R4.4)

## Justification

- J1. Why the annotator parses the output text instead of the result metadata or the scheduler/service (R1.7): the result metadata of the scheduler tool carries no due instant, the scheduler core and its result contracts stay untouched, and the success text of scheduler R1.4 and R1.5 already carries every due instant the annotation needs.
- J2. Why the ETA grammar uses hours and minutes with a seconds form only below one minute (R2.3, R2.4): schedule horizons span minutes to days, two fixed fields keep every rendered line short and comparable, and the seconds form avoids a misleading zero-hours form for imminent fires.
- J3. Why the endpoint is read-only and returns every entry unpaginated (R3.2): the per-session schedule cap of scheduler bounds the response, and schedule mutation stays on the scheduler tool with its permission ask.
- J4. Why the sidebar refreshes by triggers plus a periodic interval instead of new scheduler domain events (R4.8-R4.10): the event bus carries no schedule-mutation events, the scheduler tool-part observation covers model-driven changes, and the periodic refetch covers fires and externally changed rows without schema, protocol, and SDK churn.
- J5. Why both plugins are always-on builtins with no config keys (R1.1, R4.1): the layer is display-only with no demonstrated tuning need, mirroring the baked-constant stance of scheduler.
- J6. Why nextFireAt travels as UTC epoch milliseconds (R3.4): it matches the wire shape of the scheduler service entry, and both renderers convert to the display grammar locally.
- J7. Why the sidebar marks a gate command with a single-character indicator instead of the command text (R4.4, SCHEDULER_VIEW_SIDEBAR_GATE_MARKER): the shortened message already consumes most of the entry line's width, and presence — not content — is the actionable signal at a glance; the annotator needs no marker because the tool result already carries the scheduler/gate-echo.

## Error handling

- The annotator never fails a tool call: an internal failure appends nothing and the tool's own result stands (R1.9).
- All error results of the endpoint are final results of one request; the route retries nothing, and a client may reissue the GET.
- `InvalidRequestError` arises when the path session id fails to decode (R3.7); `SessionNotFoundError` when no session row resolves (R3.6); `UnauthorizedError` when the server auth is active and rejects the request; `UnknownError` when an unexpected defect reaches the handler, after logging with a correlating ref.
- The sidebar block treats a transport failure, a non-success response, and a decode failure alike as one failed fetch: the last successful render stands, and no failure propagates beyond the block (R4.13, R4.14).

## Usage constraints

- Adding the schedule-list endpoint is a wire-schema change of the public HttpApi: the private client generation and the legacy SDK build must both run after the protocol change, and the change is recorded in the v2 schema change ledger when that ledger is next updated.
- The annotator and the sidebar block are available only where their host ships them: the annotator where internal plugins are enabled, the sidebar block in TUI hosts that carry the built-in feature plugins; a host without the endpoint degrades per R4.13.

## Dependencies

- scheduler (R1.4, R1.5) — the annotator's input contract: the add and list success-text forms whose `next due` fragments it parses; the schedule-record fields behind the schedule-entry response; the scheduler/service as the endpoint's list source.

## Used by

None. No other spec currently cites this reference.
