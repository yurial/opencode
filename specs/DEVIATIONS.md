# Specification Deviations

## D-001 2026-09-03 specs/event-retention.md
Change: new spec event-retention introduces pruning of the durable event table
  as sync watermarks advance (R1-R9).
Was: durable event rows were never pruned; the only deletion path was
  whole-aggregate removal on session delete (event rows plus the
  event_sequence counter).
Now: while handling /sync/history, the server records the posted watermark map
  into an in-memory bounded window (last 8 maps, 24 h TTL) and deletes event
  rows of all types at or below the per-aggregate prune floor (minimum over
  the window); event_sequence counters are preserved; pruning is best-effort
  and never fails the request; local single-instance mode never prunes.
Code impact: the /sync/history handler
  (packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts)
  gains the prune side effect or delegates to a new core service; a
  delete-by-aggregate-and-seq-bound primitive in the core event module
  (packages/core/src/event).
Tests: no retention tests existed; add tests per event-retention R1-R9
  (window bounds, floor = min over window, counter preservation, restart
  prunes nothing, best-effort failure, response identical to pre-prune read).
Review focus: the floor never exceeds any live window map's posted seq for
  that aggregate; event_sequence rows are untouched by pruning; an empty or
  post-restart window prunes nothing; the sync response is unaffected by
  pruning; a prune failure does not fail the request.
