export * as Scheduler from "./scheduler"

import { Clock, Context, DateTime, Effect, Exit, Layer, Schema, Semaphore } from "effect"
import { and, asc, eq, lte } from "drizzle-orm"
import { LayerNode } from "../effect/layer-node"
import { makeGlobalNode } from "../effect/app-node"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionSchema } from "../session/schema"
import { SessionMessage } from "../session/message"
import { SessionEvent } from "../session/event"
import { SessionV2 } from "../session"
import { SessionInputTable, SessionMessageTable } from "../session/sql"
import { SessionExecution } from "../session/execution"
import { SessionStore } from "../session/store"
import { Cause } from "effect"
import { ScheduleID } from "./schema"
import { ScheduleTable } from "./sql"
import { SchedulerCron } from "./cron"
import { SchedulerMessage } from "./message"
import { SchedulerV1Prompt } from "./v1-prompt"

/**
 * Per-session add cap (specs/scheduler.md Configuration
 * SCHEDULER_MAX_SCHEDULES_PER_SESSION). An add that would exceed it fails
 * with `CapReached` (R2.4). Baked constant by design (J6).
 */
export const MAX_SCHEDULES_PER_SESSION = 50

/**
 * Message length bound in characters (specs/scheduler.md Configuration
 * SCHEDULER_MAX_MESSAGE_LENGTH). A longer `message` fails validation
 * (R3.9). Baked constant by design (J6).
 */
export const MAX_MESSAGE_LENGTH = 4096

/**
 * Delay between delivery attempts of a failing fire, in milliseconds
 * (specs/scheduler.md R8.5, Error handling). Keeps a persistently failing
 * delivery from spinning the single delivery loop while leaving the schedule
 * due until a delivery succeeds.
 */
export const RETRY_DELAY_MILLIS = 1000

/**
 * The stored firing rule of a schedule: the stored cron-spec of a recurring
 * schedule, or the due time (UTC epoch milliseconds) of a one-shot. Exactly
 * one variant per schedule — the row invariant of the Schedule record.
 */
export type Spec = { readonly cron: string } | { readonly at: number }

/**
 * The service-side view of a scheduler/schedule row (specs/scheduler.md
 * Schedule record). `spec` mirrors the exactly-one-of `cron`/`at` invariant;
 * `nextFireAt` is the stored next-due-time in UTC epoch milliseconds;
 * `timeCreated`/`timeUpdated` are the shared timestamp columns.
 */
export interface Entry {
  readonly id: ScheduleID
  readonly sessionID: SessionSchema.ID
  readonly spec: Spec
  readonly message: string
  readonly nextFireAt: number
  readonly timeCreated: number
  readonly timeUpdated: number
}

/**
 * The calling session already holds MAX_SCHEDULES_PER_SESSION schedules
 * (spec R2.4); the add stored nothing.
 */
export class CapReached extends Schema.TaggedErrorClass<CapReached>()("Scheduler.CapReached", {
  sessionID: SessionSchema.ID,
}) {}

/** No schedule with this id is bound to the calling session; nothing was removed (spec R2.3). */
export class NotFound extends Schema.TaggedErrorClass<NotFound>()("Scheduler.NotFound", {
  id: ScheduleID,
}) {}

/**
 * The scheduler/service (specs/scheduler.md Definitions, R8): the
 * process-global service node that owns schedule rows and the single
 * delivery loop of one process.
 *
 * Contract:
 * - `add` stores one schedule bound to `sessionID` (R2.1) and computes the
 *   stored next-due-time from the spec: for `{ cron }` the earliest match
 *   strictly after the current time (the spec's future-match requirement has
 *   been validated by the caller; a cron without a future match reaching this
 *   layer is a defect), for `{ at }` the given instant. Fails with
 *   `CapReached` when the session already holds the cap (R2.4); the
 *   permission ask and the argument validation belong to the tool, not here.
 * - `remove` deletes the schedule with `id` bound to `sessionID` and returns
 *   the removed entry; fails with `NotFound` — foreign or unknown ids
 *   remove nothing (R2.3).
 * - `list` returns every schedule bound to `sessionID`, ordered by id
 *   (R2.2); reads take no part in the loop's serialization.
 * - `attachV1Prompt` binds the host's V1 prompt admission capability (I4);
 *   the first attach wins and later attaches fail softly. Until an attach,
 *   a V1-routed fire fails and retries (R8.5), which also covers processes
 *   without a V1 runtime. The capability rides an attach instead of a layer
 *   dependency because the V1 prompt path depends on the tool registry,
 *   which registers the scheduler tool — a dependency edge would close a
 *   layer cycle.
 * - All mutations and fire deliveries serialize through the single delivery
 *   loop (R8.3, I6): at init the loop loads every persisted schedule, arms
 *   its timer at the earliest stored next-due-time, re-arms on every add,
 *   remove, fire, and reload (R8.4, R8.2), and delivers a fire when the
 *   current time reaches the next-due-time (R6.2) — publishing, admitting,
 *   and only then advancing or removing the row (I6). A failed delivery
 *   retries after RETRY_DELAY_MILLIS and leaves the schedule neither
 *   advanced nor removed until a delivery succeeds (R8.5); a fire whose
 *   owning session no longer exists removes the schedule and delivers
 *   nothing (R6.10). Missed-fire catch-up semantics (R7) ride the same loop.
 */
export interface Interface {
  readonly attachV1Prompt: (v1Prompt: SchedulerV1Prompt.Interface) => Effect.Effect<boolean>
  readonly add: (input: {
    readonly sessionID: SessionSchema.ID
    readonly message: string
    readonly spec: Spec
  }) => Effect.Effect<Entry, CapReached>
  readonly remove: (input: {
    readonly sessionID: SessionSchema.ID
    readonly id: ScheduleID
  }) => Effect.Effect<Entry, NotFound>
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Entry>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Scheduler") {}

type Row = typeof ScheduleTable.$inferSelect

const entryOf = (row: Row): Entry => ({
  id: row.id,
  sessionID: row.session_id,
  spec: row.cron !== null ? { cron: row.cron } : { at: row.at! },
  message: row.message,
  nextFireAt: row.next_fire_at,
  timeCreated: row.time_created,
  timeUpdated: row.time_updated,
})

const resolveNextFire = Effect.fn("Scheduler.resolveNextFire")(function* (spec: Spec, after: number) {
  if ("at" in spec) return spec.at
  const expression = SchedulerCron.parse(spec.cron)
  const next = expression === undefined ? undefined : SchedulerCron.next(expression, after)
  // The tool validates the cron form (including its future match) before the
  // spec reaches this layer, so reaching this branch is a programming error.
  if (next === undefined) return yield* Effect.die(`Scheduler spec has no future match: ${spec.cron}`)
  return next
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const sessions = yield* SessionV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service

    // The host's V1 prompt admission (I4); unset until attached, in which
    // case a V1-routed fire fails and retries (R8.5).
    let v1Prompt: SchedulerV1Prompt.Interface | undefined

    const loadedAt = yield* Clock.currentTimeMillis
    // Serializes tool mutations with fire deliveries (R8.3, I6).
    const writes = yield* Semaphore.make(1)
    // Nudges the timer on every mutation and fire (R8.4).
    const wake = yield* Semaphore.make(0)
    // Schedule ids whose last delivery attempt failed; their retries are
    // catch-up fires (R7.1) and their rows stay due until success (R8.5).
    const failedDeliveries = new Set<string>()

    const earliest = Effect.fn("Scheduler.earliest")(function* () {
      const row = yield* db
        .select({ nextFireAt: ScheduleTable.next_fire_at })
        .from(ScheduleTable)
        .orderBy(asc(ScheduleTable.next_fire_at))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return row?.nextFireAt
    })

    /**
     * Routes by the session's observable runtime state (I7): a session with
     * durable V2 state — an admitted inbox input or projected V2 history —
     * is served by the V2 runtime; every other recorded session is served by
     * the V1 runtime.
     */
    const servedByV2 = Effect.fn("Scheduler.servedByV2")(function* (sessionID: SessionSchema.ID) {
      const input = yield* db
        .select({ id: SessionInputTable.id })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, sessionID))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (input !== undefined) return true
      const message = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return message !== undefined
    })

    const deliver = Effect.fn("Scheduler.deliver")(function* (row: Row, now: number) {
      const session = yield* store.get(row.session_id)
      if (session === undefined) {
        // R6.10: a fire whose owning session no longer exists removes the
        // schedule and delivers nothing — a log line, no event.
        yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, row.id)).run().pipe(Effect.orDie)
        failedDeliveries.delete(row.id)
        yield* Effect.logWarning("Scheduler dropped a schedule whose session no longer exists").pipe(
          Effect.annotateLogs({ scheduleID: row.id, sessionID: row.session_id }),
        )
        return
      }

      const catchUp = row.next_fire_at < loadedAt || failedDeliveries.has(row.id)
      const specForm = SchedulerMessage.spec({ cron: row.cron ?? undefined, at: row.at ?? undefined })
      const text = SchedulerMessage.fired({
        scheduledFireAt: row.next_fire_at,
        id: row.id,
        spec: specForm,
        message: row.message,
        catchUp,
      })

      if (yield* servedByV2(row.session_id)) {
        // R6.3: one durable ContextUpdated event, no context-epoch advance —
        // the publish carries no commit hook (SessionContextEpoch precedent).
        yield* events.publish(SessionEvent.ContextUpdated, {
          sessionID: row.session_id,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          text,
        })
        // R6.4 with I5: admit-only prompt admission, then the loop issues the
        // execution wake itself after the publish.
        yield* sessions.prompt({ sessionID: row.session_id, prompt: { text }, resume: false })
        yield* execution.wake(row.session_id)
      } else {
        // R6.5: one synthetic user text part through the V1 prompt path.
        if (v1Prompt === undefined) {
          return yield* Effect.fail(
            new SchedulerV1Prompt.Error({ detail: "no V1 prompt admission is attached to the scheduler" }),
          )
        }
        yield* v1Prompt.prompt({ sessionID: row.session_id, text })
      }
      failedDeliveries.delete(row.id)

      // I6: advance or remove only after publish and admission succeeded.
      if (row.cron !== null) {
        // R6.8 / R7.4: a normal fire advances from the discharged time, a
        // catch-up fire from the delivery time.
        const advanceFrom = catchUp ? now : row.next_fire_at
        const expression = SchedulerCron.parse(row.cron)
        const next = expression === undefined ? undefined : SchedulerCron.next(expression, advanceFrom)
        if (next === undefined) {
          yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, row.id)).run().pipe(Effect.orDie)
          yield* Effect.logWarning("Scheduler removed a schedule whose cron has no future match").pipe(
            Effect.annotateLogs({ scheduleID: row.id, cron: row.cron }),
          )
          return
        }
        yield* db
          .update(ScheduleTable)
          .set({ next_fire_at: next })
          .where(eq(ScheduleTable.id, row.id))
          .run()
          .pipe(Effect.orDie)
        return
      }
      // R6.9: a one-shot is removed after its delivered fire.
      yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, row.id)).run().pipe(Effect.orDie)
    })

    const deliverDue = Effect.fn("Scheduler.deliverDue")(function* () {
      const now = yield* Clock.currentTimeMillis
      const due = yield* db
        .select()
        .from(ScheduleTable)
        .where(lte(ScheduleTable.next_fire_at, now))
        .orderBy(asc(ScheduleTable.next_fire_at))
        .all()
        .pipe(Effect.orDie)
      let failed = false
      for (const row of due) {
        const attempt = yield* deliver(row, now).pipe(Effect.exit)
        if (Exit.isSuccess(attempt)) continue
        // R8.5: the schedule is neither advanced nor removed; the retry is a
        // catch-up fire (R7.1).
        failed = true
        failedDeliveries.add(row.id)
        yield* Effect.logError("Scheduler delivery failed; the schedule stays due").pipe(
          Effect.annotateLogs({ scheduleID: row.id, sessionID: row.session_id, cause: Cause.pretty(attempt.cause) }),
        )
      }
      return failed
    })

    const runLoop = Effect.forever(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const next = yield* earliest()
        if (next === undefined) yield* wake.take(1)
        else yield* Effect.race(wake.take(1), Effect.sleep(Math.max(0, next - now)))
        const failed = yield* writes.withPermits(1)(deliverDue())
        if (failed) yield* Effect.sleep(RETRY_DELAY_MILLIS)
      }),
    )
    yield* runLoop.pipe(Effect.forkScoped)

    return Service.of({
      attachV1Prompt: Effect.fn("Scheduler.attachV1Prompt")(function* (attached) {
        if (v1Prompt !== undefined) return false
        v1Prompt = attached
        return true
      }),
      add: Effect.fn("Scheduler.add")(function* (input) {
        const nextFireAt = yield* resolveNextFire(input.spec, yield* Clock.currentTimeMillis)
        return yield* writes.withPermits(1)(
          Effect.gen(function* () {
            const held = yield* db
              .select({ id: ScheduleTable.id })
              .from(ScheduleTable)
              .where(eq(ScheduleTable.session_id, input.sessionID))
              .all()
              .pipe(Effect.orDie)
            if (held.length >= MAX_SCHEDULES_PER_SESSION) return yield* new CapReached({ sessionID: input.sessionID })
            const now = yield* Clock.currentTimeMillis
            const row = {
              id: ScheduleID.create(),
              session_id: input.sessionID,
              cron: "cron" in input.spec ? input.spec.cron : null,
              at: "at" in input.spec ? input.spec.at : null,
              message: input.message,
              next_fire_at: nextFireAt,
              time_created: now,
              time_updated: now,
            }
            yield* db.insert(ScheduleTable).values(row).run().pipe(Effect.orDie)
            yield* wake.release(1)
            return entryOf(row as Row)
          }),
        )
      }),
      remove: Effect.fn("Scheduler.remove")(function* (input) {
        return yield* writes.withPermits(1)(
          Effect.gen(function* () {
            const row = yield* db
              .delete(ScheduleTable)
              .where(and(eq(ScheduleTable.id, input.id), eq(ScheduleTable.session_id, input.sessionID)))
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (row === undefined) return yield* new NotFound({ id: input.id })
            failedDeliveries.delete(row.id)
            yield* wake.release(1)
            return entryOf(row)
          }),
        )
      }),
      list: Effect.fn("Scheduler.list")(function* (sessionID) {
        const rows = yield* db
          .select()
          .from(ScheduleTable)
          .where(eq(ScheduleTable.session_id, sessionID))
          .orderBy(asc(ScheduleTable.id))
          .all()
          .pipe(Effect.orDie)
        return rows.map(entryOf)
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionV2.node, SessionStore.node, SessionExecution.node],
})
