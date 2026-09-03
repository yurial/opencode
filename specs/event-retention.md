# Event Retention Specification

Status: draft
Spec source of truth for: retention of the durable event log — pruning event
rows below replica event-retention/watermark values as they advance.

## Overview

The durable event log grows without bound while replicas remain behind or
depart. This spec fixes a retention mechanism for the sync deployment mode: the
server observes the event-retention/watermark-map records replicas already post
on every `/sync/history` request, derives a conservative per-aggregate
event-retention/prune-floor from the most recently posted maps, and deletes
durable event rows at or below that floor. The sequence counter per aggregate
is preserved, so event production, idempotent replay, and existing consumers
are unaffected. Local single-instance operation never syncs and therefore
never prunes.

## Scope

In: observation of posted event-retention/watermark-map records,
event-retention/window maintenance, event-retention/prune-floor computation,
deletion of durable event rows below the floor in sync mode.

Out (non-goals): retention for local single-instance mode; storage file
reclamation (VACUUM); mutation of the per-aggregate sequence counter;
protocol, endpoint-signature, or SDK changes; type-based or tenant-based
retention exceptions.

## Definitions

- **event-retention/watermark**: the per-aggregate value inside a posted
  event-retention/watermark-map — a non-negative integer declaring the highest
  event `seq` the replica already possesses for that aggregate.
- **event-retention/watermark-map**: the complete record a replica posts as the
  `/sync/history` request payload, mapping aggregate IDs to
  event-retention/watermark values; aggregates the replica does not know are
  absent from the map.
- **event-retention/window**: the server's in-memory, bounded collection of the
  most recently posted event-retention/watermark-map entries, each stamped with
  its receipt time; it holds at most the `SYNC_WATERMARK_WINDOW_SIZE` newest
  maps and no map older than `SYNC_WATERMARK_TTL`.
- **event-retention/prune-floor**: for one aggregate, the minimum
  event-retention/watermark for that aggregate over the
  event-retention/watermark-map entries currently in the
  event-retention/window; aggregates absent from every map in the
  event-retention/window have no event-retention/prune-floor and are never
  pruned.

## Interface

The existing `POST /sync/history` endpoint keeps its external contract exactly:
the request payload is the replica's event-retention/watermark-map (aggregate
ID → non-negative integer), the response is the ordered list of sync events.
The endpoint gains one side effect: while handling the request the server may
prune durable event rows per this spec. No new endpoints, request fields,
response fields, or client-visible errors are introduced. Pruning is invisible
to clients except that events below the event-retention/prune-floor stop being
returned to requesters that do not already declare possession of them.

## Configuration

| Name | Allowed values | Default | Effect |
|---|---|---|---|
| `SYNC_WATERMARK_WINDOW_SIZE` | `fixed` 8 watermark maps | — | Capacity of the event-retention/window (R2); recording a map beyond 8 evicts the oldest (R2); more concurrently posting replicas than 8 cause the least recently posted map to drop out and lose protection (Constraints) |
| `SYNC_WATERMARK_TTL` | `fixed` 24 hours | — | Maximum age of a map inside the event-retention/window (R2); older maps are treated as absent when floors are computed (R3), bounding how long a departed replica's map can hold the event-retention/prune-floor down (R3) |

## Behavior

- R1. The server prunes durable event rows only while handling a
  `/sync/history` request. No background job, timer, or other code path prunes
  events; a server that receives no sync requests never prunes.
- R2. On each `/sync/history` request, before any pruning, the server records
  the posted event-retention/watermark-map into the event-retention/window,
  stamped with the receipt time. The event-retention/window holds at most the
  `SYNC_WATERMARK_WINDOW_SIZE` newest maps; recording beyond the capacity
  evicts the oldest map. A map older than `SYNC_WATERMARK_TTL` is treated as
  absent from the event-retention/window at every subsequent evaluation.
- R3. For each aggregate, the server computes the event-retention/prune-floor
  as the minimum event-retention/watermark for that aggregate over the maps
  currently in the event-retention/window (per R2's age rule). An aggregate
  absent from every live map has no floor and is never pruned. An empty event-retention/window
  yields no floors and no pruning. Because expired and evicted maps drop out, a
  departed replica's stale map cannot hold a floor down indefinitely.
- R4. For every aggregate with a floor, the server deletes durable event rows
  of all event types where the aggregate matches and `seq` is less than or
  equal to the event-retention/prune-floor. The deletion never touches the
  per-aggregate sequence counter rows; surviving rows may have gaps in `seq`,
  and reads remain `seq` greater than a cursor.
- R5. Ordering per request: record the map (R2) → compute floors (R3) → prune
  (R4) → read and return the response. Because the requesting replica's own map
  is already in the event-retention/window when floors are computed, every deleted row has
  `seq` ≤ that replica's own event-retention/watermark, so the response is
  identical to a read taken before pruning. Aggregates absent from the
  requester's map are served from the surviving (post-prune) rows.
- R6. Pruning is best-effort: any failure during deletion is logged with the
  affected aggregates and floors, and the request continues — the response is
  still produced from the current state. A prune failure never fails the
  request and is never reported to the client as an error.
- R7. The event-retention/window lives only in server process memory. After a
  server restart the event-retention/window is empty; per R3 no pruning occurs until replicas
  post new maps. This is the safe direction: restart can only pause retention,
  never make it more aggressive.
- R8. Whole-aggregate deletion (session removal) deletes that aggregate's event
  rows and its sequence counter. Stale maps in the event-retention/window
  referencing a deleted aggregate are inert: the floor matches zero rows, the
  counter is not resurrected, and a later recreate of the same aggregate ID is
  unaffected.
- R9. Pruning does not affect replay idempotency or sequence allocation. A
  replay of an event whose row was already pruned re-inserts that row at its
  original `seq` without changing the counter, and replay of an event at or
  below a replica's posted event-retention/watermark remains a no-op for that
  replica.

Example (R2–R5): the event-retention/window holds map M1 = `{s1: 10, s2: 4}` (age 1 h) and
M2 = `{s1: 7}` (age 2 h). Floors: `s1` → min(10, 7) = 7; `s2` → 4. The server
deletes `s1` rows with `seq` ≤ 7 and `s2` rows with `seq` ≤ 4, counters
untouched. A requester posting `{s1: 7, s2: 4}` gets a response identical to a
pre-prune read; a requester posting only `{s1: 7}` additionally receives `s2`
rows from `seq` 5 onward (the surviving tail).

## Constraints

- Safety invariant: the event-retention/prune-floor never exceeds any
  event-retention/watermark for that aggregate among the maps currently in the
  event-retention/window. A replica's rows are protected exactly while its map
  is in the event-retention/window; therefore a live replica must post more frequently than
  `SYNC_WATERMARK_TTL` to retain continuous protection. A replica silent longer
  than the TTL may lose rows it has not yet received; this v1 trade-off is
  accepted and affects only that replica.
- History below the floor is irrecoverable: a replica that never declared
  possession of an aggregate (its map lacks the aggregate) receives only the
  surviving tail, never the pruned prefix.
- No storage file reclamation happens: deleted rows free pages but do not
  shrink the database file; no VACUUM is run by this mechanism.
- Memory bound: the event-retention/window holds at most `SYNC_WATERMARK_WINDOW_SIZE` maps;
  per-map size is proportional to the posting replica's aggregate count.
- Compatibility: the `/sync/history` request and response shapes are unchanged;
  clients and SDKs require no changes.

## Error handling

One error class: prune failure (any storage error while deleting rows below a
floor). The server logs the failure with the affected aggregates and their
floors, serves the response from the current state, and returns success to the
client. No retry is attempted within the failing request; the next
`/sync/history` request recomputes floors and retries pruning implicitly. All
other request failures (malformed payload, storage failure while reading the
response) behave exactly as before this spec — pruning adds no new
client-visible errors.

## Dependencies

None. This spec is self-contained: it defines its own terms and fixed
constants and relies on no other spec's terms, interfaces, or constraints.

## Used by

None. No other spec currently cites this reference.

## Verification

None. No algorithm of this spec has been checked with a formal tool.
