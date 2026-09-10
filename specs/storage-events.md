# Storage, Events, and Sync Specification

Status: stable
Spec source of truth for: the SQLite durable storage runtime (packages/core database
module and the vendored Effect Drizzle SQLite adapter), the JSON file storage
(packages/opencode storage), the database schema and migration pipeline, the EventV2
durable event log with the in-process event bus, the event manifests and the opencode
event bridge, the SSE event delivery, and the experimental workspace sync protocol.

## Overview

Opencode persists state in two physical stores: a single-process SQLite database
(opened through a vendored Drizzle-over-Effect adapter) holds accounts, projects,
workspaces, sessions, messages, permissions, credentials, and the durable event log;
a small JSON key-value tree under the data directory holds leftovers that never moved
to SQLite (for example revert diffs). Domain mutations that must be replayable are
published as durable events: each event is assigned a per-aggregate sequence number
inside an immediate transaction that also runs registered projectors, and is appended
to the `event` table. In-process consumers subscribe through PubSub streams; remote
consumers (the experimental workspace sync and SSE clients) receive events through the
bridge, the global bus, and the `/sync/*` + `/event` HTTP endpoints. Retention of the
durable log in sync mode is governed by the event-retention spec and is not restated
here.

## Scope

In: database file placement and backend selection; connection/transaction semantics of
the Effect SQLite runtime and the vendored Drizzle adapter; the migration pipeline and
schema ownership rules; the JSON file storage contract; EventV2 definition, publish,
subscription, projector, replay, ownership-claim, and removal semantics; event
manifests; the opencode event bridge and GlobalBus; SSE event delivery; the
experimental workspace sync protocol (history pull, live replay, ownership transfer).

Out (non-goals): retention policy itself (owned by event-retention); session runner and
prompt admission semantics (V2 session core); HTTP API surface beyond the sync/event
endpoints' behavioral contract; the legacy V1 `Bus` SDK event shapes; TUI/desktop
consumers of events; auth and account domain logic stored in the tables.

## Definitions

- **storage-events/database-file**: the single SQLite file opened by the core database
  service; resolved per Configuration below, located under the XDG data directory
  (`<xdgData>/opencode/`) unless overridden.
- **storage-events/file-storage**: the JSON key-value tree at
  `<xdgData>/opencode/storage/`, addressed by string key arrays, one `.json` file per
  key.
- **storage-events/durable-event**: an event whose definition carries
  `durable: { version, aggregate }`; it is persisted in the `event` table with a
  per-aggregate `seq`.
- **storage-events/live-event**: an event without a `durable` flag (for example
  `message.part.delta`); it is delivered in-process only and never persisted.
- **storage-events/aggregate**: the entity a durable event belongs to, identified by
  the string value of the data field named by the definition's `aggregate` property.
  Every durable definition shipped today uses `sessionID`, so aggregates are sessions.
- **storage-events/aggregate-sequence**: the per-aggregate monotonically increasing
  counter kept in `event_sequence.seq` (absent ⇒ conceptual −1, next seq 0).
- **storage-events/owner**: the `event_sequence.owner_id` value — the workspace ID
  currently entitled to write an aggregate (single-writer discipline).
- **storage-events/projector**: an in-process callback registered for one event type
  that runs inside the durable commit transaction and updates local read models.
- **storage-events/commit-hook**: the optional `commit` callback of a publish; a local
  operational projection executed atomically with the durable event commit, never
  serialized or replayed.
- **storage-events/replay**: re-committing a serialized durable event (id, aggregateID,
  seq, type, data) through the same transactional path as a publish, with idempotent
  outcome for an exact repeat.
- **storage-events/pruned-replay**: a replay whose `seq` is at or below the preserved
  counter but whose row is absent because it was pruned; it re-inserts the log row
  without running projectors or moving the counter (event-retention R9).
- **storage-events/global-bus**: the process-wide `EventEmitter` (`GlobalBus`) that
  fans out `{ directory, project, workspace, payload }` envelopes to SSE bridges and
  sync loops.

Terms reused from event-retention (not redefined): event-retention/watermark-map,
event-retention/watermark, event-retention/prune-floor, event-retention/window.

## Interface

### Database service (`packages/core/src/database/database.ts`)

```ts
Database.Service: Context.Service yielding { db: EffectSQLiteDatabase }
Database.path(): string                    // resolution per R1
Database.layerFromPath(filename): Layer    // test/alternate-path entry point
Database.node                              // process-global singleton node (deps: none)
```

`db` is the vendored adapter's database: Drizzle query builders that are
Effect-yieldable, plus `db.run/all/get(sql)` raw statements and
`db.transaction(effect, { behavior })`.

### Vendored adapter (`packages/effect-drizzle-sqlite`, `@opencode-ai/effect-drizzle-sqlite`)

```ts
EffectDrizzleSqlite.make(config): Effect<EffectSQLiteDatabase, never, SqlClient | EffectCache | EffectLogger>
EffectDrizzleSqlite.makeWithDefaults(config): Effect<...>          // DefaultServices provided
EffectDrizzleSqlite.migrate(db, config): Effect<void>              // drizzle folder migrator (unused by core)
```

SQLite backend selection is the `#sqlite` import in packages/core: `bun` →
`sqlite.bun.ts`, `node` → `sqlite.node.ts`, default → bun. Each exposes
`layer({ filename, readonly?, disableWAL?, ... })` providing `Sqlite.Native`,
the Effect `SqlClient`, and `Sqlite.Drizzle`.

The standalone package `@opencode-ai/effect-sqlite-node`
(`packages/effect-sqlite-node/src/index.ts`) exports an equivalent
`NodeSqliteClient.make/layer` over `node:sqlite`; packages/core declares it as a
dependency but does not import it — core uses its own `sqlite.node.ts` copy.

### File storage (`packages/opencode/src/storage/storage.ts`)

```ts
Storage.Service: {
  read<T>(key: string[]): Effect<T, Storage.Error>          // NotFoundError when absent
  write(key: string[], content: unknown): Effect<void>
  update<T>(key: string[], fn: (draft: T) => void): Effect<T>  // read-modify-write under write lock
  remove(key: string[]): Effect<void>                          // missing target is a no-op
  list(prefix: string[]): Effect<string[][]>                   // file keys under prefix, sorted
}
```

### EventV2 (`packages/core/src/event.ts`)

```ts
EventV2.Service / EventV2Bridge.Service: {
  publish<D>(definition: D, data: Data<D>, options?: { id?, metadata?, location?, commit?(seq) }): Effect<Payload<D>>
  subscribe<D>(definition: D): Stream<Payload<D>>
  all(): Stream<Payload>
  durable({ aggregateID, after? }): Stream<Payload>
  listen(listener): Effect<Unsubscribe>                       // deprecated
  project<D>(definition: D, projector: (event) => Effect<void>): Effect<void>
  replay(event: SerializedEvent, options?: { publish?, ownerID?, strictOwner? }): Effect<void>
  replayAll(events: SerializedEvent[], options?): Effect<string | undefined>
  remove(aggregateID: string): Effect<void>
  claim(aggregateID: string, ownerID: string): Effect<void>
}
EventV2.latestSequence(db, aggregateID): Effect<number>       // −1 when absent
EventV2.readAggregate(db, { aggregateID, after?, limit, manifest }): Effect<{ events, hasMore }>
EventV2.prune(db, floors: Iterable<[aggregateID, floor]>): Effect<void>
EventV2.allBounded(events, capacity): Effect<Stream<Payload>>
```

`SerializedEvent = { id, type, aggregateID, seq, data }` where `type` is the
versioned type `"<type>.<version>"` (for example `session.created.1`) — the exact
string stored in the `event.type` column.

### Manifests

- `@opencode-ai/schema/event-manifest` exports `Definitions` (full inventory),
  `ServerDefinitions` (server-safe subset), `Latest` (highest version per type), and
  `Durable` (versionedType → definition map of all durable definitions).
- `packages/opencode/src/event-manifest.ts` re-exports
  `{ Definitions, Durable, Latest }`.

### HTTP (instance HttpApi)

- `GET /event` — SSE stream (see R34).
- `POST /sync/start` — starts sync loops for the current project's workspaces;
  returns `true`.
- `POST /sync/replay` — payload `{ directory, events: NonEmptyArray<ReplayEvent> }`;
  replays one aggregate's contiguous history; response `{ sessionID }`.
- `POST /sync/steal` — payload `{ sessionID }`; moves the session into the current
  workspace.
- `POST /sync/history` — payload is the event-retention/watermark-map; response is
  the ordered list of surviving `event` rows (`{ id, aggregate_id, seq, type, data }`,
  snake_case columns) with `seq` greater than the posted per-aggregate value; unknown
  aggregates get their full history.

## Configuration

| Name | Allowed values | Default | Effect |
|---|---|---|---|
| `OPENCODE_DB` | string: `:memory:`, absolute path, or relative file name | unset | Overrides the database file location (R1); relative names resolve under the XDG data directory |
| `OPENCODE_DISABLE_CHANNEL_DB` | `1` or `true` | unset | Forces the channel-suffixed database name off (R1) |
| `OPENCODE_EXPERIMENTAL_WORKSPACES` | experimental-flag truthy values | off | Gates workspace listing and sync-loop startup (R35); off ⇒ sync never starts |
| `5000` ms, `PRAGMA busy_timeout` | `magic` 5000 ms | — | SQLite busy timeout applied at database startup (R2) |
| `-64000` KiB, `PRAGMA cache_size` | `magic` −64000 (64 MiB) | — | Page cache budget applied at database startup (R2) |
| `10` seconds, SSE heartbeat interval | `magic` 10 s | — | `server.heartbeat` emission cadence on `GET /event` (R34); first heartbeat after one interval |
| `1000 * 2 ** attempt`, capped `120000` ms | `magic` 1000 ms base, 120000 ms cap | — | Sync reconnect backoff; doubling per failed cycle, reset after a successful connection (R39) |
| `10` events per batch | `magic` 10 | — | Chunk size of `/sync/replay` batches during session warp (R41) |

Fixed values owned elsewhere: `SYNC_WATERMARK_WINDOW_SIZE` (8) and
`SYNC_WATERMARK_TTL` (24 h) are defined in the event-retention Configuration and are
not restated here. WAL journal mode, `synchronous = NORMAL`, `foreign_keys = ON`, and
the passive WAL checkpoint are qualitative startup pragmas (R2).

## Behavior

### Physical storage and database runtime

- R1. The database file is resolved as: `OPENCODE_DB` equal to `:memory:` or an
  absolute path is used verbatim; a relative `OPENCODE_DB` value resolves under
  `<xdgData>/opencode/`; otherwise, on the `latest`, `beta`, or `prod` release
  channels — or when `OPENCODE_DISABLE_CHANNEL_DB` is `1`/`true` — the file is
  `<xdgData>/opencode/opencode.db`; any other channel uses
  `opencode-<sanitized-channel>.db` in the same directory, with non
  `[a-zA-Z0-9._-]` characters replaced by `-`.
- R2. Constructing the database service applies, in order: `journal_mode = WAL`,
  `synchronous = NORMAL`, `busy_timeout = 5000`, `cache_size = -64000`,
  `foreign_keys = ON`, `wal_checkpoint(PASSIVE)`, then the migration pipeline
  (R7–R9). Any failure during construction is a defect: the layer dies instead of
  serving a half-initialized database. The service is a process-global singleton.
- R3. The SQLite backend exposes one connection. Statements execute under a
  single-permit semaphore; a transaction acquires the permit for its fiber's scope, so
  a transaction excludes every other statement on that database until it commits or
  rolls back. Nested `db.transaction` calls inside an active transaction do not open a
  second transaction: they create `SAVEPOINT effect_sql_<depth>` and release/rollback
  to that savepoint. `{ behavior: "immediate" }` issues `BEGIN IMMEDIATE` (the default
  is `deferred`). A commit failure triggers a best-effort rollback and then fails.
- R4. All Drizzle query builders (`select/insert/update/delete`, raw `sql`) are
  Effect-yieldable values; the adapter depends only on the generic Effect
  `SqlClient` plus Drizzle's logger/cache services, never on a concrete SQLite driver
  (packages/effect-drizzle-sqlite/AGENTS.md).
- R5. The JSON file storage maps a key array to
  `<data>/storage/<joined-key>.json`, written as pretty-printed JSON. Reads of a
  missing file fail with `NotFoundError`; `remove` of a missing file succeeds;
  `update` performs read-modify-write under the target file's write lock and returns
  the mutated document; `list` returns only file keys under the prefix, sorted by
  joined path. Per-file re-entrant read/write locks serialize concurrent access
  in-process only.
- R6. File-storage migrations run once at service construction, ordered by index,
  tracked by the plain-text `migration` marker file holding the next index. A failed
  step is logged and aborts the remaining steps for this startup without advancing the
  marker, so the next start retries it. The two shipped steps are legacy layout
  migrations (git-root-commit project re-keying; session-diff extraction).
- R7. On an empty database (no user tables), bootstrap runs one transaction that
  creates the full baseline schema (`schema.gen.ts`) and the `migration` journal table
  `(id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)` with every registered
  migration already marked complete. Fresh installs never replay incremental
  migrations.
- R8. On a database containing the `session` table, each pending migration (in
  ascending id order) runs in its own transaction together with its journal insert;
  a migration failure rolls back that migration only. A database with user tables but
  no `session` table is rejected with a defect. The apply pipeline is guarded by a
  process-wide semaphore.
- R9. When the new journal is empty and a legacy Drizzle `__drizzle_migrations` table
  exists, the journal is seeded from it before applying: `name`-column rows copy their
  names directly; otherwise each `created_at` timestamp maps to the registered
  migration whose id starts with the timestamp's `strftime('%Y%m%d%H%M%S')` prefix,
  and an unmatched timestamp is a defect.
- R10. Migrations are generated, not hand-written: `bun script/migration.ts` from
  packages/core runs drizzle-kit against the committed snapshot
  (`packages/core/schema.json`), emits at most one new TypeScript migration per run,
  and regenerates both the full-schema module (`schema.gen.ts`) and the sorted
  registry (`migration.gen.ts`); `--check` fails when any of the three is stale.

### Schema ownership and conventions

- R11. Table definitions live exclusively in packages/core, colocated with their
  domain in `sql.ts` / `*.sql.ts` modules (`account`, `credential`,
  `control-plane/workspace`, `data-migration`, `event`, `permission`, `project`,
  `session`, `share`). `packages/opencode/src/storage/schema.ts` only re-exports them;
  no table may be declared in packages/opencode.
- R12. Drizzle columns are declared with snake_case field names so column names are
  never redefined as strings (AGENTS.md style rule). Shared `Timestamps`
  (`time_created`/`time_updated`) default and update client-side to `Date.now()`
  unless set explicitly.
- R13. Path-valued columns use the custom columns of
  `packages/core/src/database/path.ts`: `absoluteColumn` validates absoluteness and
  round-trips `AbsolutePath` (Windows backslashes normalized to `/` in storage);
  `directoryColumn` additionally tolerates the legacy empty-string directory;
  `pathColumn` stores the slash-normalized string verbatim; `absoluteArrayColumn`
  stores a JSON array of validated absolute paths. A non-absolute input to a
  validating column throws.
- R14. The schema comprises the tables `workspace`, `data_migration`,
  `account_state`, `account`, `control_account`, `credential`, `event_sequence`,
  `event`, `permission`, `project_directory`, `project`, `message`, `part`,
  `session_context_epoch`, `session_input`, `session_message`, `session`, `todo`,
  `session_share`, with foreign keys cascading on delete from their owners (except
  `account_state.active_account_id`, which clears). Data backfills ride the same
  migration pipeline as DDL (for example `20260510033149_session_usage.ts`).

### Event model, manifests, and the durable log

- R15. An event payload is `{ id, type, data, durable?, location?, metadata? }` with
  `id` of the form `evt_<ascending>`. A definition is durable when it declares
  `durable: { version, aggregate }`. The durable row stores the versioned type
  `"<type>.<version>"` in `event.type`; read paths remap it back to the manifest
  definition's bare `type`.
- R16. `Latest` selects, per type, the definition with the highest durable version
  and rejects duplicate non-versioned definitions; `Durable` keys every durable
  definition by versioned type and rejects duplicate keys. `Durable` contains exactly
  the legacy V1 session/message events (`session.created/updated/deleted`,
  `message.updated/removed`, `message.part.updated/removed`, version 1) plus the V2
  `session.next.*` durable set; streaming deltas (`Text.Delta`, `Reasoning.Delta`,
  `Tool.Input.Delta`, `Compaction.Delta`, `message.part.delta`) are live-events.
- R17. Publishing a durable event computes the aggregate id as the string value of
  `data[definition.durable.aggregate]`; a missing or non-string value is a defect.
- R18. Durable publish is uninterruptible and commits in a single
  `behavior: "immediate"` transaction that: reads the aggregate counter; encodes the
  data with the definition schema; allocates `seq = latest + 1`; rejects an event id
  already present on any row (defect); runs every projector registered for the type;
  runs the optional commit-hook; upserts the counter; inserts the event row. Any
  failure rolls back the whole transaction — event, counter, projections, and
  commit-hook land atomically or not at all. Database errors inside this path become
  defects.
- R19. After a successful commit (and only then), the service wakes durable-stream
  subscribers for that aggregate and notifies the bus; the payload delivered
  downstream carries `durable: { aggregateID, seq, version }`. The publishing
  location is `options.location` when given, else the ambient `Location.Service`
  reference when one is in scope, else absent.
- R20. Publishing a live-event performs no database access and notifies the bus
  immediately. Passing a `commit` hook with a non-durable definition is a defect.
- R21. Bus notification order per event: registered `listen` listeners in
  registration order, then the typed PubSub channel for the event type, then the
  all-events channel. Durable publishes isolate listener failures (logged, delivery
  continues); live-event publishes propagate listener failures to the publisher.
- R22. `subscribe` and `all` return unbounded in-memory PubSub streams with no
  persistence: a subscriber sees only events published after subscription.
- R23. The `durable({ aggregateID, after })` stream registers its wake channel
  before performing the initial read, so no committed event can be missed between
  subscription and first delivery; it delivers the historical batch with `seq >
  after` (default −1) ordered ascending, then live batches re-read on every wake,
  advancing the cursor to the last delivered `seq`. Decoding a row whose versioned
  type is absent from the `Durable` manifest fails with `InvalidDurableEvent`.
- R24. `latestSequence` returns the counter value, or −1 when the aggregate is
  unknown. `readAggregate` filters rows to the supplied manifest's types, pages with
  `limit + 1` to report `hasMore`, and decodes through the manifest's union schema.
- R25. `project` registers an in-process projector for one event type. Projectors run
  inside the durable commit transaction (R18) on publish and on non-pruned replay;
  a projector failure aborts the commit. Projector registration is process-local —
  other processes converge through replay. (Known limitation: projectors are keyed by
  type only, not type+version.)
- R26. Replay looks the type up in the `Durable` manifest (unknown type is a defect),
  decodes the data with the definition schema, and re-commits with the supplied
  `{ seq, aggregateID }`:
  - a stored row at that `(aggregate_id, seq)` that matches id, versioned type, and
    deep-equal data is an idempotent no-op (the row owner is backfilled when the
    replay carries an owner and the stored owner is null) — no notify, no re-projection;
  - a stored row that differs is a defect ("replay diverged");
  - no stored row with `seq ≤ latest` is a storage-events/pruned-replay: the row is
    re-inserted at its original `seq` without running projectors and without moving
    the counter (event-retention R9);
  - `seq > latest + 1` (and not a pruned replay) is a defect (sequence mismatch).
- R27. Ownership: a replay carrying `ownerID` against an aggregate whose stored owner
  differs is silently skipped — no error, no notify, no writes. With `strictOwner`
  the same situation is a defect. Local publishes (no replay input) ignore ownership.
  `claim(aggregateID, ownerID)` overwrites the stored owner unconditionally.
- R28. `replayAll` requires every event to belong to one aggregate and to occupy
  contiguous ascending sequence numbers starting at the first event's `seq` (else
  defect), replays sequentially, and returns the aggregate id; an empty array returns
  `undefined`.
- R29. `remove(aggregateID)` deletes the counter row and the aggregate's event rows
  in one transaction and notifies nobody; a later publish on the same id restarts the
  sequence at 0. Stale watermark maps referencing the removed aggregate are inert
  (event-retention R8).
- R30. `prune` deletes only `event` rows at or below the supplied per-aggregate
  floors and never touches counters; the retention policy computing those floors and
  its ordering/safety rules are owned by event-retention R1–R9 and are implemented by
  `EventV2.prune` plus the `/sync/history` handler.
- R31. `allBounded` bridges the bus into a dropping queue of the given capacity; on
  overflow the stream terminates with `SubscriberOverflowError` and the subscription
  is released.

### Bridge, GlobalBus, and SSE delivery

- R32. The opencode event bridge (`packages/opencode/src/event-v2-bridge.ts`) wraps
  `EventV2.Service`: `publish` attaches the routed instance location (directory,
  workspace id, project id + worktree) when the caller supplied none and an instance
  context is in scope; every other method forwards unchanged.
- R33. The bridge installs one listener on the core bus that, for every event, emits
  on the GlobalBus an envelope `{ directory, project, workspace, payload: { id, type,
  properties: data } }`; for each durable event it emits a second envelope with
  payload `{ type: "sync", syncEvent: { id, type: versionedType, seq, aggregateID,
  data } }`. The GlobalBus stamps a missing `payload.id` from `syncEvent.id` or a
  fresh ascending `evt_` id.
- R34. `GET /event` (SSE) registers its queue before streaming, emits
  `server.connected` first, then delivers only events whose `location.directory`
  equals the instance directory and whose `location.workspaceID` is absent or equal to
  the routed workspace, as `{ id, type, properties }`, merged with a `server.heartbeat`
  every 10 seconds, and terminates after a `server.instance.disposed` envelope for
  that directory. Events without a location are filtered out.

### Sync

- R35. Sync is experimental: workspace listing and sync-loop startup are gated by the
  workspaces experimental flag; when off, sync loops never start and the durable log
  is never pruned (event-retention R1).
- R36. For each remote workspace of a project with active sessions, the sync loop
  connects to the remote's SSE stream, then pulls history once, then replays live
  events; connection state transitions are surfaced as workspace status
  (`connecting`, `connected`, `disconnected`, `error`). A local-directory workspace
  target never starts a loop.
- R37. The history pull posts the local event-retention/watermark-map — the current
  `event_sequence.seq` values for the sessions assigned to that workspace — to the
  remote `POST /sync/history`, and replays every returned row locally with
  `{ publish: true, ownerID: <workspace id> }` in arrival order. The remote returns
  surviving rows with `seq` greater than the posted value per aggregate and full
  history for aggregates absent from the map; the request also triggers the remote's
  retention pruning per event-retention R1–R7.
- R38. Live sync replays each `sync` envelope's `syncEvent` individually with
  `{ publish: true, ownerID }`; a failed replay is logged and the event is not
  re-emitted locally. Non-sync envelopes are re-emitted on the local GlobalBus tagged
  with the workspace id.
- R39. After a disconnect the loop reconnects after `min(120000, 1000 · 2^attempt)`
  ms, incrementing `attempt` per failed cycle and resetting it after a successful
  connection.
- R40. Conflict semantics are single-writer per aggregate, never merge: the aggregate
  owner (R27) is the only workspace whose replays are accepted; a non-owner's events
  are silently dropped. Ownership moves only through an explicit transfer —
  `claim` during warp/steal — which first performs a final best-effort history pull
  from the previous owner. `POST /sync/replay` on a workspace applies
  `strictOwner: true` with the receiving workspace as owner, so replaying into an
  aggregate owned elsewhere is rejected as a defect.
- R41. Warping a session to another workspace: performs the final source sync from
  the previous workspace (best-effort, logged on failure) or cancels a local prompt;
  claims the session for the new owner (`workspaceID`, falling back to the project
  id) so late events from the old owner are ignored; optionally computes the source
  VCS diff and applies it to the target before any move — both steps are best-effort
  (a failed diff yields an empty patch and a failed apply degrades to
  `{ applied: false }`, logged, warp continues); ships the session's complete durable history to the target in
  batches of 10 via `POST /sync/replay`; calls `POST /sync/steal` on the target;
  then updates the local `session.workspace_id`. Moving to `null` only clears the
  local workspace assignment.
- R42. `POST /sync/steal` requires a routed workspace context (otherwise
  `BadRequest`) and sets the session's workspace to it.

## Constraints

- The event bus is in-process only; cross-process delivery exists solely through the
  sync protocol and SSE. There is no durable broker.
- One SQLite connection per process (R3) serializes writers; WAL plus the 5 s busy
  timeout are the only cross-process contention mitigations. Multi-process writes to
  the same database file are unsupported.
- Sequence numbers are per aggregate and dense within a live counter; pruned history
  leaves permanent gaps (event-retention R4) and pruned prefixes are irrecoverable.
- The file storage offers no cross-process locking and no schema validation of
  stored documents beyond per-call decode at call sites.
- The vendored adapter must stay generic: no opencode paths, tables, migrations, or
  domain language inside `packages/effect-drizzle-sqlite` (storage-effect-sqlite).
- `@opencode-ai/effect-sqlite-node` and core's `sqlite.node.ts` are parallel
  implementations of the same node:sqlite client shape; only the latter is wired into
  the `#sqlite` resolution.
- Retention never reclaims file space (no VACUUM) and never mutates counters
  (event-retention).

## Error handling

- Defects (`Effect.die`, startup-fatal or transaction-rolling-back): unknown durable
  event type; missing/non-string aggregate field; replay aggregate or sequence
  mismatch; diverged replay; duplicate event id; strict-owner violation; commit hook
  on a live-event; non-empty database without a `session` table; unmatched legacy
  migration timestamp; invalid absolute path in a path column.
- Typed errors: `EventV2.InvalidDurableEventError` (also used as the defect payload
  class), `EventV2.SubscriberOverflowError` (stream failure), storage
  `NotFoundError`, sync `SyncHttpError` / `SessionWarpHttpError` (non-2xx remote
  responses), `WorkspaceNotFoundError` / `SessionEventsNotFoundError` during warp.
- Best-effort paths that never fail their caller: retention pruning inside
  `/sync/history` (logged, event-retention R6); live replay failures in the sync
  loop (logged per event); the warp's final source sync (logged); file-storage
  migration steps (logged, retried next start); isolated bus listener failures
  (logged).
- Sync HTTP failures surface as workspace status `error` and a retried connection
  with backoff; they are never propagated to the remote client.

## Dependencies

- event-retention — implements its R1–R9 via `EventV2.prune`, the
  `SyncWatermark` window, and the `/sync/history` handler; reuses the terms
  event-retention/watermark-map, event-retention/watermark,
  event-retention/prune-floor, event-retention/window; R26/R29/R30/R35/R37/R40 cite
  its requirement IDs.
- storage-effect-sqlite — the vendored adapter package whose public surface
  (`make`/`makeWithDefaults`/`migrate`) is the database runtime's foundation (R3,
  R4, Interface).

## Used by

None. No other spec currently cites this reference.

## Verification

None. No algorithm of this spec has been checked with a formal tool.

## Module map (informative)

| File | Responsibility | Contract |
|---|---|---|
| `packages/core/src/database/database.ts` | Database service: path resolution, pragmas, migrations, global node | R1, R2 |
| `packages/core/src/database/sqlite.ts` / `sqlite.bun.ts` / `sqlite.node.ts` | `#sqlite` backend selection; native handle, SqlClient, Drizzle client layers | R3, R4 |
| `packages/core/src/database/migration.ts` / `migration.gen.ts` / `migration/` / `schema.gen.ts` | Journal, bootstrap, legacy-journal adoption, migration registry | R7–R10 |
| `packages/core/script/migration.ts`, `packages/core/drizzle.config.ts`, `packages/core/schema.json` | Migration generation and freshness check | R10 |
| `packages/core/src/database/path.ts` | Path custom columns | R13 |
| `packages/core/src/database/schema.sql.ts` | Shared `Timestamps` | R12 |
| `packages/core/src/**/sql.ts`, `*.sql.ts` | Table ownership (9 modules, 19 tables) | R11, R14 |
| `packages/core/src/event/sql.ts` | `event` / `event_sequence` tables and indexes | R15–R30 |
| `packages/core/src/event.ts` | EventV2 service: publish, bus, projectors, replay, ownership, prune | R15–R31 |
| `packages/schema/src/event.ts` | Definition/payload types, ID, manifests helpers (`latest`, `durable`, `versionedType`) | R15, R16 |
| `packages/schema/src/event-manifest.ts`, `durable-event-manifest.ts` | Inventory composition | R16 |
| `packages/opencode/src/event-manifest.ts` | Re-export shim for the opencode package | R16 |
| `packages/opencode/src/event-v2-bridge.ts` | Publish boundary + GlobalBus fan-out | R32, R33 |
| `packages/opencode/src/bus/global.ts` | Process-wide GlobalBus emitter | R33 |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts` | SSE `/event` | R34 |
| `packages/opencode/src/storage/storage.ts` | JSON file storage + legacy file migrations | R5, R6 |
| `packages/opencode/src/storage/schema.ts` | Table re-export shim (no definitions) | R11 |
| `packages/opencode/src/sql.d.ts` | `*.sql` module declaration for raw SQL imports | — |
| `packages/opencode/src/sync/README.md` | Historical design note for the removed `SyncEvent` API (superseded by EventV2) | — |
| `packages/opencode/src/sync/schema.ts` | Unused legacy `EventID` shim | — |
| `packages/opencode/src/server/projectors.ts`, `init-projectors.ts` | Empty stubs of the removed projector boundary | — |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts` | `/sync/*` handlers incl. retention hook | R37, R40–R42 |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/sync-watermark.ts` | event-retention window (owned by event-retention) | R37 |
| `packages/opencode/src/control-plane/workspace.ts` | Workspace sync loop, history pull, warp/claim/steal | R35–R41 |
| `packages/effect-drizzle-sqlite/src/**` | Vendored Drizzle Effect SQLite adapter (driver, session, migrator, up-migrations) | R3, R4 |
| `packages/effect-sqlite-node/src/index.ts` | Standalone node:sqlite Effect client (not wired into core) | Constraints |
