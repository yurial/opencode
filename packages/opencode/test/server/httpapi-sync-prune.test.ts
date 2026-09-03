import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Effect, Layer } from "effect"
import { inArray } from "drizzle-orm"
import { Session } from "@/session/session"
import { SyncPaths } from "../../src/server/routes/instance/httpapi/groups/sync"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, Database.node])), httpApiLayer),
)

type HistoryRow = {
  id: string
  aggregate_id: string
  seq: number
  type: string
  data: Record<string, unknown>
}

const postHistory = (directory: string, payload: Record<string, number>) =>
  requestInDirectory(SyncPaths.history, directory, {
    method: "POST",
    headers: { "x-opencode-directory": directory, "content-type": "application/json" },
    body: JSON.stringify(payload),
  })

const maxSeq = (rows: HistoryRow[], aggregateID: string) =>
  Math.max(...rows.filter((row) => row.aggregate_id === aggregateID).map((row) => row.seq))

describe("sync watermark prune", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.instance(
    "prunes durable events below the watermark floor and preserves sequence counters",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const { db } = yield* Database.Service
        const session1 = yield* Session.use.create({ title: "prune-1" })
        const session2 = yield* Session.use.create({ title: "prune-2" })
        yield* Session.use.touch(session1.id)
        yield* Session.use.touch(session2.id)
        const ids = [session1.id, session2.id]
        const dbRows = Effect.gen(function* () {
          return yield* db
            .select()
            .from(EventTable)
            .where(inArray(EventTable.aggregate_id, [...ids]))
            .all()
            .pipe(Effect.orDie)
        })
        const counters = Effect.gen(function* () {
          return yield* db
            .select()
            .from(EventSequenceTable)
            .where(inArray(EventSequenceTable.aggregate_id, [...ids]))
            .all()
            .pipe(Effect.orDie)
        })

        const keys = (rows: Array<{ aggregate_id: string; seq: number }>) =>
          rows
            .map((row) => [row.aggregate_id, row.seq] as const)
            .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1))

        // First request with an empty map: the window holds no live watermark
        // for any aggregate, so nothing is pruned (R3).
        const initial = yield* postHistory(tmp.directory, {})
        expect(initial.status).toBe(200)
        const before = (yield* initial.json) as HistoryRow[]
        expect(keys(yield* dbRows)).toEqual(keys(before))
        const floor1 = maxSeq(before, session1.id)
        const floor2 = maxSeq(before, session2.id)

        // Second request posts {s1: 0}: only s1 rows with seq <= 0 are pruned.
        const advanced = yield* postHistory(tmp.directory, { [session1.id]: 0 })
        expect(advanced.status).toBe(200)
        // R5: the response is identical to a read taken before pruning — rows
        // at or below the requester's own posted watermark are excluded.
        const afterAdvanced = (yield* advanced.json) as HistoryRow[]
        expect(afterAdvanced).toEqual(before.filter((row) => !(row.aggregate_id === session1.id && row.seq <= 0)))

        // Third request posts aggressive watermarks. The window holds both
        // maps, so floor(s1) = min(0, floor1) = 0 protects the surviving s1
        // tail, while floor(s2) = floor2 prunes s2 entirely (R3).
        const aggressive = yield* postHistory(tmp.directory, { [session1.id]: floor1, [session2.id]: floor2 })
        expect(aggressive.status).toBe(200)
        const afterAggressive = (yield* aggressive.json) as HistoryRow[]
        expect(afterAggressive).toEqual(
          before.filter(
            (row) =>
              !(row.aggregate_id === session1.id && row.seq <= floor1) &&
              !(row.aggregate_id === session2.id && row.seq <= floor2),
          ),
        )

        // R4: rows at or below the floors are deleted, counters untouched.
        const pruned = yield* dbRows
        expect(pruned.filter((row) => row.aggregate_id === session1.id).map((row) => row.seq)).toEqual(
          before.filter((row) => row.aggregate_id === session1.id).map((row) => row.seq).filter((seq) => seq > 0),
        )
        expect(pruned.filter((row) => row.aggregate_id === session2.id)).toEqual([])
        const counterRows = yield* counters
        expect(counterRows).toHaveLength(2)
        expect(counterRows).toEqual(
          expect.arrayContaining([
            { aggregate_id: session1.id, seq: floor1, owner_id: null },
            { aggregate_id: session2.id, seq: floor2, owner_id: null },
          ]),
        )

        // R9 end-to-end: replaying the pruned rows re-inserts them at their
        // original seq without moving the counter.
        const replayed = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers: { "x-opencode-directory": tmp.directory, "content-type": "application/json" },
          body: JSON.stringify({
            directory: tmp.directory,
            events: before
              .filter((row) => row.aggregate_id === session1.id)
              .map((row) => ({
                id: row.id,
                aggregateID: row.aggregate_id,
                seq: row.seq,
                type: row.type,
                data: row.data,
              })),
          }),
        })
        expect(replayed.status).toBe(200)
        expect(yield* replayed.json).toEqual({ sessionID: session1.id })
        expect((yield* dbRows).filter((row) => row.aggregate_id === session1.id).map((row) => row.seq)).toEqual(
          before.filter((row) => row.aggregate_id === session1.id).map((row) => row.seq),
        )
        expect((yield* counters).find((row) => row.aggregate_id === session1.id)?.seq).toBe(floor1)

        // R9: for the replica owning seq 0, the replayed rows stay no-ops —
        // its next read returns the surviving tail, not the pruned prefix.
        const tail = yield* postHistory(tmp.directory, { [session1.id]: 0 })
        expect((yield* tail.json) as HistoryRow[]).toEqual(
          before.filter(
            (row) => !(row.aggregate_id === session1.id && row.seq <= 0) && row.aggregate_id !== session2.id,
          ),
        )
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
