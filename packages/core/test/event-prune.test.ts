import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@opencode-ai/schema/session"
import { SessionV1 } from "@opencode-ai/schema/session-v1"
import { eq, inArray } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const DurableMessage = SessionV1.Event.MessageRemoved
const durableData = (sessionID: Session.ID, text: string) => ({
  sessionID,
  messageID: SessionV1.MessageID.ascending(`msg_${text}`),
})

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))

const seed = (aggregateID: Session.ID, count: number) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    return yield* Effect.forEach(
      Array.from({ length: count }, (_, index) => index),
      (index) =>
        Effect.gen(function* () {
          const data = durableData(aggregateID, `m${index}`)
          const published = yield* events.publish(DurableMessage, data)
          return {
            id: published.id,
            type: EventV2.versionedType(DurableMessage.type, 1),
            seq: published.durable!.seq,
            aggregateID,
            data,
          }
        }),
    )
  })

const prune = (floors: Array<readonly [string, number]>) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* EventV2.prune(db, floors)
  })

const rows = (aggregateIDs: readonly string[]) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(EventTable)
      .where(inArray(EventTable.aggregate_id, [...aggregateIDs]))
      .all()
      .pipe(Effect.orDie)
  })

const sequence = (aggregateID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ seq: EventSequenceTable.seq })
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, aggregateID))
      .get()
      .pipe(Effect.orDie)
  })

describe("EventV2.prune", () => {
  it.effect("deletes rows at or below the floor and preserves the sequence counter", () =>
    Effect.gen(function* () {
      const aggregateID = Session.ID.create()
      yield* seed(aggregateID, 4)

      yield* prune([[aggregateID, 1]])

      expect((yield* rows([aggregateID])).map((row) => row.seq)).toEqual([2, 3])
      // R4: the counter row survives untouched, so allocation continues from 3.
      expect(yield* sequence(aggregateID)).toEqual({ seq: 3 })
    }),
  )

  it.effect("leaves aggregates without a floor untouched", () =>
    Effect.gen(function* () {
      const withFloor = Session.ID.create()
      const withoutFloor = Session.ID.create()
      yield* seed(withFloor, 2)
      yield* seed(withoutFloor, 2)

      yield* prune([[withFloor, 0]])

      expect((yield* rows([withFloor])).map((row) => row.seq)).toEqual([1])
      expect((yield* rows([withoutFloor])).map((row) => row.seq)).toEqual([0, 1])
      expect(yield* sequence(withoutFloor)).toEqual({ seq: 1 })
    }),
  )

  it.effect("replays a pruned seq back at its original position without moving the counter", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const published = yield* seed(aggregateID, 3)
      yield* prune([[aggregateID, 1]])

      // R9: the pruned row at seq 0 re-inserts at its original seq; the
      // preserved counter keeps allocation and idempotent replay intact.
      yield* events.replay(published[0]!)

      expect((yield* rows([aggregateID])).map((row) => row.seq)).toEqual([0, 2])
      expect(yield* sequence(aggregateID)).toEqual({ seq: 2 })

      yield* events.replay(published[0]!)
      expect((yield* rows([aggregateID])).map((row) => row.seq)).toEqual([0, 2])
      expect(yield* sequence(aggregateID)).toEqual({ seq: 2 })
    }),
  )

  it.effect("replays a surviving seq as an exact-match no-op", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const published = yield* seed(aggregateID, 2)
      yield* prune([[aggregateID, 0]])

      // seq 1 survived the prune; replaying it must stay a no-op.
      yield* events.replay(published[1]!)

      expect((yield* rows([aggregateID])).map((row) => row.seq)).toEqual([1])
      expect(yield* sequence(aggregateID)).toEqual({ seq: 1 })
    }),
  )

  it.effect("stale floors are inert after whole-aggregate removal", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      yield* seed(aggregateID, 3)
      yield* prune([[aggregateID, 1]])
      yield* events.remove(aggregateID)

      // R8: a stale window floor referencing the removed aggregate matches zero
      // rows and does not resurrect the counter.
      yield* prune([[aggregateID, 1]])

      expect(yield* rows([aggregateID])).toEqual([])
      expect(yield* sequence(aggregateID)).toBeUndefined()

      // Recreating the same aggregate ID is unaffected.
      yield* seed(aggregateID, 1)
      expect((yield* rows([aggregateID])).map((row) => row.seq)).toEqual([0])
      expect(yield* sequence(aggregateID)).toEqual({ seq: 0 })
    }),
  )
})
