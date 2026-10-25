import { describe, expect } from "bun:test"
import { Clock, Deferred, Duration, Effect, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "@opencode-ai/core/database/database"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionContextEpochTable, SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Scheduler } from "@opencode-ai/core/scheduler/scheduler"
import { SchedulerV1Prompt } from "@opencode-ai/core/scheduler/v1-prompt"
import { ScheduleID } from "@opencode-ai/core/scheduler/schema"
import { ScheduleTable } from "@opencode-ai/core/scheduler/sql"
import { SchedulerMessage } from "@opencode-ai/core/scheduler/message"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const wakeCalls: SessionV2.ID[] = []

const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set<SessionV2.ID>()),
    resume: (sessionID) =>
      Effect.sync(() => {
        wakeCalls.push(sessionID)
      }),
    interrupt: () => Effect.void,
    wake: (sessionID) =>
      Effect.sync(() => {
        wakeCalls.push(sessionID)
      }),
  }),
)

type V1Call = { readonly sessionID: SessionV2.ID; readonly text: string }
const v1Calls: V1Call[] = []
const v1Behavior = {
  failuresLeft: 0,
  // When set, the fake admission performs this add synchronously inside the
  // prompt call and records the created id — the old host behavior of running
  // the whole model turn (its tools included) inside the admission. The
  // delivery loop must survive it.
  reentrantAdd: undefined as { readonly sessionID: SessionV2.ID; readonly message: string } | undefined,
  reentrantAdds: [] as string[],
}
// When set, the fake V1 admission blocks until released — the serialization
// probe of the single delivery loop.
let v1Gate: Deferred.Deferred<void> | undefined

// The fake V1 admission attaches itself to the scheduler service (the same
// inversion hosts perform): the scheduler must not depend on it as a layer.
const v1promptNode = LayerNode.make({
  service: SchedulerV1Prompt.Service,
  layer: Layer.effect(
    SchedulerV1Prompt.Service,
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Service
      const v1Prompt = SchedulerV1Prompt.Service.of({
        prompt: (input) =>
          Effect.suspend(() => {
            v1Calls.push({ sessionID: input.sessionID, text: input.text })
            if (v1Behavior.failuresLeft > 0) {
              v1Behavior.failuresLeft--
              return Effect.fail(new SchedulerV1Prompt.Error({ detail: "injected delivery failure" }))
            }
            const gate = v1Gate
            const admitted = gate ? Effect.asVoid(Deferred.await(gate)) : Effect.void
            const reentrant = v1Behavior.reentrantAdd
            if (!reentrant) return admitted
            return Effect.gen(function* () {
              // The fake never holds enough schedules to reach the cap; a
              // CapReached here would be a test bug, not a delivery failure.
              const added = yield* scheduler
                .add({
                  sessionID: reentrant.sessionID,
                  message: reentrant.message,
                  spec: { cron: "* * * * *" },
                })
                .pipe(Effect.orDie)
              v1Behavior.reentrantAdds.push(added.id)
              yield* admitted
            })
          }),
      })
      yield* scheduler.attachV1Prompt(v1Prompt)
      return v1Prompt
    }),
  ),
  deps: [Scheduler.node],
})

const nodes = LayerNode.group([
  Database.node,
  EventV2.node,
  SessionProjector.node,
  SessionV2.node,
  Scheduler.node,
  v1promptNode,
])
const replacements = [[SessionExecution.node, execution]] as const

const it = testEffect(AppNodeBuilder.build(nodes, replacements))
// Restart-style tests manage their own stacks over a file-backed database;
// the ambient layer stays empty.
const itStandalone = testEffect(Layer.empty)

const makeSession = (sessionID: SessionV2.ID) =>
  Database.Service.use(({ db }) =>
    Effect.gen(function* () {
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }),
  )

/** Seeds V2 state for a session so fire routing selects the V2 path. */
const seedV2State = (sessionID: SessionV2.ID) =>
  Database.Service.use(({ db }) =>
    db
      .insert(SessionInputTable)
      .values({
        id: SessionMessage.ID.make("msg_seed_v2_state"),
        session_id: sessionID,
        prompt: { text: "seed" },
        delivery: "steer",
        admitted_seq: 1_000_000,
        time_created: 0,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )

const seedEpoch = (sessionID: SessionV2.ID) =>
  Database.Service.use(({ db }) =>
    db
      .insert(SessionContextEpochTable)
      .values({ session_id: sessionID, baseline: "baseline-0", snapshot: {}, baseline_seq: 5 })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )

const seedSchedules = (sessionID: SessionV2.ID, count: number, nextFireAt: number) =>
  Database.Service.use(({ db }) =>
    Effect.forEach(
      Array.from({ length: count }, (_, index) => index),
      (index) =>
        db
          .insert(ScheduleTable)
          .values({
            id: ScheduleID.create(),
            session_id: sessionID,
            cron: "0 0 * * *",
            message: `seed ${index}`,
            next_fire_at: nextFireAt,
          })
          .run()
          .pipe(Effect.orDie),
      { discard: true },
    ),
  )

const epochRow = (sessionID: SessionV2.ID) =>
  Database.Service.use(({ db }) =>
    db
      .select()
      .from(SessionContextEpochTable)
      .where(eq(SessionContextEpochTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie),
  )

const scheduleRows = Database.Service.use(({ db }) =>
  db.select().from(ScheduleTable).all().pipe(Effect.orDie),
)

const eventCount = (type: string) =>
  Database.Service.use(({ db }) =>
    db
      .select({ id: EventTable.id })
      .from(EventTable)
      .where(eq(EventTable.type, type))
      .all()
      .pipe(Effect.orDie, Effect.map((rows) => rows.length)),
  )

const contextUpdatedType = EventV2.versionedType("session.next.context.updated", 1)

const resetRecordings = Effect.sync(() => {
  wakeCalls.length = 0
  v1Calls.length = 0
  v1Behavior.failuresLeft = 0
  v1Behavior.reentrantAdd = undefined
  v1Behavior.reentrantAdds.length = 0
  v1Gate = undefined
})

const now = Clock.currentTimeMillis
const advance = (millis: number) => TestClock.adjust(Duration.millis(millis))

const settled = Effect.gen(function* () {
  yield* Effect.yieldNow
  yield* Effect.yieldNow
})

describe("Scheduler service", () => {
  it.effect("computes the stored next due time from the spec at add", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_add_cron")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service
      const started = yield* now

      const recurring = yield* scheduler.add({
        sessionID,
        message: "check CI status",
        spec: { cron: "*/30 * * * *" },
      })
      const oneShot = yield* scheduler.add({
        sessionID,
        message: "ship it",
        spec: { at: started + 3_600_000 },
      })

      // The next due time is a minute-aligned */30 match strictly after the
      // current instant, at most half an hour out.
      const nextMinute = recurring.nextFireAt / 60_000
      expect(recurring.nextFireAt % 60_000).toBe(0)
      expect(nextMinute % 30).toBe(0)
      expect(recurring.nextFireAt).toBeGreaterThan(started)
      expect(recurring.nextFireAt - started).toBeLessThanOrEqual(30 * 60_000)
      expect(oneShot.nextFireAt).toBe(started + 3_600_000)

      const rows = yield* scheduleRows
      expect(rows).toHaveLength(2)
      expect(rows.every((row) => row.cron === null || row.at === null)).toBe(true)
    }),
  )

  it.effect("isolates list and remove to the calling session", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const scheduler = yield* Scheduler.Service
      const owner = SessionV2.ID.make("ses_owner")
      const stranger = SessionV2.ID.make("ses_stranger")
      yield* makeSession(owner)

      const added = yield* scheduler.add({ sessionID: owner, message: "secret plan", spec: { cron: "0 12 * * *" } })

      expect(yield* scheduler.list(stranger)).toEqual([])
      const owned = yield* scheduler.list(owner)
      expect(owned).toHaveLength(1)
      expect(owned[0]!.id).toBe(added.id)
      expect(owned[0]!.message).toBe("secret plan")

      const foreign = yield* scheduler.remove({ sessionID: stranger, id: added.id }).pipe(Effect.flip)
      expect(foreign._tag).toBe("Scheduler.NotFound")
      expect(yield* scheduler.list(owner)).toHaveLength(1)

      const removed = yield* scheduler.remove({ sessionID: owner, id: added.id })
      expect(removed.id).toBe(added.id)
      expect(yield* scheduler.list(owner)).toEqual([])
    }),
  )

  it.effect("rejects the add at the per-session cap", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const scheduler = yield* Scheduler.Service
      const capped = SessionV2.ID.make("ses_capped")
      yield* makeSession(capped)
      yield* seedSchedules(capped, Scheduler.MAX_SCHEDULES_PER_SESSION, (yield* now) + 60_000)

      const rejected = yield* scheduler
        .add({ sessionID: capped, message: "one too many", spec: { cron: "0 0 * * *" } })
        .pipe(Effect.flip)
      expect(rejected._tag).toBe("Scheduler.CapReached")
      expect(yield* scheduleRows).toHaveLength(Scheduler.MAX_SCHEDULES_PER_SESSION)

      yield* Database.Service.use(({ db }) =>
        db
          .delete(ScheduleTable)
          .where(eq(ScheduleTable.session_id, capped))
          .run()
          .pipe(Effect.orDie),
      )
      const underCap = SessionV2.ID.make("ses_under_cap")
      yield* makeSession(underCap)
      yield* seedSchedules(underCap, Scheduler.MAX_SCHEDULES_PER_SESSION - 1, (yield* now) + 60_000)
      const accepted = yield* scheduler.add({
        sessionID: underCap,
        message: "fiftieth",
        spec: { cron: "0 0 * * *" },
      })
      expect(accepted.message).toBe("fiftieth")
    }),
  )

  it.effect("cascades schedule removal with the session row", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const scheduler = yield* Scheduler.Service
      const sessionID = SessionV2.ID.make("ses_doomed")
      yield* makeSession(sessionID)
      yield* scheduler.add({ sessionID, message: "remember me", spec: { cron: "0 0 * * *" } })
      expect(yield* scheduleRows).toHaveLength(1)

      yield* Database.Service.use(({ db }) =>
        db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie),
      )
      expect(yield* scheduleRows).toEqual([])
    }),
  )

  it.effect("registers the schedule table through the migration registry", () =>
    Effect.gen(function* () {
      expect(migrations.some((migration) => migration.id === "20261024202807_add_schedule_table")).toBe(true)
    }),
  )

  it.effect("delivers a V2 fire without advancing the context epoch", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_v2_fire")
      yield* makeSession(sessionID)
      yield* seedV2State(sessionID)
      yield* seedEpoch(sessionID)
      const scheduler = yield* Scheduler.Service
      const before = yield* epochRow(sessionID)

      const added = yield* scheduler.add({
        sessionID,
        message: "check CI status",
        spec: { cron: "*/30 * * * *" },
      })
      yield* advance(added.nextFireAt + 1)
      yield* settled

      // One durable ContextUpdated event carrying the fired message.
      expect(yield* eventCount(contextUpdatedType)).toBe(1)
      const session = yield* SessionV2.Service
      const messages = yield* session.messages({ sessionID })
      expect(messages).toHaveLength(1)
      expect(messages[0]!.type).toBe("system")
      const text = messages[0]!.type === "system" ? messages[0]!.text : ""
      expect(text).toContain("fired schedule id")
      expect(text).toContain("check CI status")

      // One admitted durable input carrying the same text (admit-only form).
      const inputs = yield* Database.Service.use(({ db }) =>
        db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).all().pipe(Effect.orDie),
      )
      const admitted = inputs.filter((row) => row.id !== "msg_seed_v2_state")
      expect(admitted).toHaveLength(1)
      expect(admitted[0]!.prompt).toMatchObject({ text })
      expect(admitted[0]!.promoted_seq).toBeNull()

      // The delivery loop issues the execution wake itself.
      expect(wakeCalls).toEqual([sessionID])

      // No context-epoch advance: the published event carries no commit hook.
      expect(yield* epochRow(sessionID)).toEqual(before)

      // The V1 path stayed silent.
      expect(v1Calls).toEqual([])
    }),
  )

  it.effect("fires the converted cron form and advances from the discharged time", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_every_fire")
      yield* makeSession(sessionID)
      yield* seedV2State(sessionID)
      const scheduler = yield* Scheduler.Service

      // every 1d converts to 0 0 * * * at add time; only the cron form fires.
      const added = yield* scheduler.add({ sessionID, message: "standup", spec: { cron: "0 0 * * *" } })
      expect(added.spec).toEqual({ cron: "0 0 * * *" })
      yield* advance(added.nextFireAt + 1)
      yield* settled

      const session = yield* SessionV2.Service
      const messages = yield* session.messages({ sessionID })
      const text = messages[0]!.type === "system" ? messages[0]!.text : ""
      // The spec slot of the fired text is exactly the stored cron form, never
      // the relative `every 1d` phrasing. Matching the exact id-spec-message
      // segment keeps the check deterministic: the random bytes of the
      // schedule id can contain any short substring, so a whole-text
      // not.toContain("1d") flakes whenever the id happens to hold "1d".
      expect(text).toContain(`fired schedule id ${added.id} 0 0 * * *: standup`)

      const rows = yield* scheduleRows
      expect(rows).toHaveLength(1)
      // The next due time is the earliest match strictly after the discharged time.
      expect(rows[0]!.next_fire_at).toBe(added.nextFireAt + 86_400_000)
      expect(yield* eventCount(contextUpdatedType)).toBe(1)
    }),
  )

  it.effect("removes a one-shot after its delivered fire", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_one_shot")
      yield* makeSession(sessionID)
      yield* seedV2State(sessionID)
      const scheduler = yield* Scheduler.Service

      const added = yield* scheduler.add({
        sessionID,
        message: "deploy",
        spec: { at: (yield* now) + 60_000 },
      })
      yield* advance(added.nextFireAt + 1)
      yield* settled

      expect(yield* eventCount(contextUpdatedType)).toBe(1)
      expect(yield* scheduleRows).toEqual([])
    }),
  )

  it.effect("routes a session without V2 state through the V1 prompt path", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_v1_fire")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service

      const added = yield* scheduler.add({
        sessionID,
        message: "v1 reminder",
        spec: { cron: "* * * * *" },
      })
      yield* advance(added.nextFireAt + 1)
      yield* settled

      expect(v1Calls).toHaveLength(1)
      expect(v1Calls[0]!.sessionID).toBe(sessionID)
      expect(v1Calls[0]!.text).toContain("fired schedule id")
      expect(v1Calls[0]!.text).toContain("v1 reminder")
      expect(yield* eventCount(contextUpdatedType)).toBe(0)
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("drops the schedule of a dead session without delivering", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const scheduler = yield* Scheduler.Service
      const ghost = SessionV2.ID.make("ses_ghost")
      yield* makeSession(ghost)

      const added = yield* scheduler.add({ sessionID: ghost, message: "anyone?", spec: { cron: "* * * * *" } })
      // The owning session disappears before the due time.
      yield* Database.Service.use(({ db }) =>
        db.delete(SessionTable).where(eq(SessionTable.id, ghost)).run().pipe(Effect.orDie),
      )
      yield* advance(added.nextFireAt + 1)
      yield* settled

      expect(yield* scheduleRows).toEqual([])
      expect(yield* eventCount(contextUpdatedType)).toBe(0)
      expect(v1Calls).toEqual([])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("does not re-deliver before the next due time", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_quiet")
      yield* makeSession(sessionID)
      yield* seedV2State(sessionID)
      const scheduler = yield* Scheduler.Service

      const added = yield* scheduler.add({ sessionID, message: "once", spec: { cron: "0 * * * *" } })
      yield* advance(added.nextFireAt + 1)
      yield* settled
      expect(yield* eventCount(contextUpdatedType)).toBe(1)

      // Displaced fired messages are never re-delivered (R9.1): the scheduler
      // stays silent until the next due occurrence, whatever happens to
      // history in between.
      yield* advance(59 * 60_000)
      yield* settled
      expect(yield* eventCount(contextUpdatedType)).toBe(1)

      yield* advance(2 * 60_000)
      yield* settled
      expect(yield* eventCount(contextUpdatedType)).toBe(2)
    }),
  )

  it.effect("serializes deliveries and mutations through the single loop", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_serial")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service

      const first = yield* scheduler.add({ sessionID, message: "first", spec: { cron: "* * * * *" } })
      const second = yield* scheduler.add({ sessionID, message: "second", spec: { cron: "* * * * *" } })
      // Route this session through V1 so the gated fake admission applies,
      // then let both due schedules reach the loop: the first delivery starts
      // and blocks inside the fake admission.
      v1Gate = yield* Deferred.make<void>()
      yield* advance(first.nextFireAt + 1)
      yield* settled
      expect(v1Calls).toHaveLength(1)
      expect(v1Calls[0]!.text).toContain("first")

      // While the first delivery is in flight, the second due schedule is not
      // picked up, and a concurrent add proceeds without waiting for the
      // in-flight V1 admission — the loop permit is released across it.
      const addFiber = yield* scheduler
        .add({ sessionID, message: "third", spec: { cron: "* * * * *" } })
        .pipe(Effect.forkScoped)
      yield* settled
      expect(v1Calls).toHaveLength(1)

      yield* Deferred.succeed(v1Gate!, undefined)
      yield* settled

      // The second due schedule ran after the first, in order.
      expect(v1Calls).toHaveLength(2)
      expect(v1Calls[1]!.text).toContain("second")
      const third = yield* Fiber.join(addFiber)
      expect(third.message).toBe("third")
      expect(second.id).not.toBe(first.id)
    }),
  )

  it.effect("completes a scheduler mutation made from inside a V1 turn", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_v1_reentrant")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service

      // Regression: the fake admission replays the old host behavior — the
      // model turn reacting to the fired message runs inside the admission
      // and calls scheduler.add. The old loop held its write permit across
      // the admission, so the add waited for the permit the loop waited on:
      // self-deadlock. Both the fire and the turn's add must complete.
      v1Behavior.reentrantAdd = { sessionID, message: "from the turn" }
      const added = yield* scheduler.add({ sessionID, message: "fires", spec: { cron: "* * * * *" } })
      yield* advance(added.nextFireAt + 1)
      yield* settled

      expect(v1Calls).toHaveLength(1)
      expect(v1Calls[0]!.text).toContain("fires")
      expect(v1Behavior.reentrantAdds).toHaveLength(1)

      const rows = yield* scheduleRows
      expect(rows).toHaveLength(2)
      const fired = rows.find((row) => row.message === "fires")
      const fromTurn = rows.find((row) => row.message === "from the turn")
      expect(fired).toBeDefined()
      expect(fromTurn).toBeDefined()
      // The fired schedule advanced past the current time.
      expect(fired!.next_fire_at).toBeGreaterThan(yield* now)
    }),
  )

  it.effect("advances a catch-up fire from the delivery completion time", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_slow_delivery")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service

      // The first delivery fails; the retry is a catch-up fire whose
      // admission blocks until it is released.
      v1Behavior.failuresLeft = 1
      v1Gate = yield* Deferred.make<void>()
      const added = yield* scheduler.add({ sessionID, message: "slow", spec: { cron: "0 * * * *" } })
      const due = added.nextFireAt
      yield* advance(due + 1)
      yield* settled
      expect(v1Calls).toHaveLength(1)

      // The retry delivery takes longer than the remaining interval: the
      // clock moves past the next occurrence while the admission is in
      // flight.
      yield* advance(61 * 60_000)
      yield* Deferred.succeed(v1Gate!, undefined)
      yield* settled

      // The catch-up advance starts at the delivery completion time (R7.4):
      // a full hour after the completion, not the already-past hour after
      // the retry attempt began.
      const rows = yield* scheduleRows
      expect(rows).toHaveLength(1)
      expect(rows[0]!.next_fire_at).toBe(due + 2 * 3_600_000)
      expect(v1Calls).toHaveLength(2)
      expect(v1Calls[1]!.text).toContain("catch-up")

      // No immediate extra fire: the timer re-armed on the advanced time.
      yield* advance(30 * 60_000)
      yield* settled
      expect(v1Calls).toHaveLength(2)
    }),
  )

  it.effect("retries a failed delivery as a catch-up and leaves the schedule due", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_retry")
      yield* makeSession(sessionID)
      v1Behavior.failuresLeft = 1
      const scheduler = yield* Scheduler.Service

      const added = yield* scheduler.add({ sessionID, message: "persistent", spec: { cron: "0 * * * *" } })
      const due = added.nextFireAt
      yield* advance(due + 1)
      yield* settled

      // First attempt failed: no marker was pending yet, the row is untouched.
      expect(v1Calls).toHaveLength(1)
      expect(v1Calls[0]!.text).not.toContain("catch-up")
      let rows = yield* scheduleRows
      expect(rows).toHaveLength(1)
      expect(rows[0]!.next_fire_at).toBe(due)

      // The retry happens after the retry delay and surfaces as a catch-up
      // fire with the same scheduled fire time (J7).
      yield* advance(Scheduler.RETRY_DELAY_MILLIS + 1)
      yield* settled
      expect(v1Calls).toHaveLength(2)
      expect(v1Calls[1]!.text).toContain("catch-up: delivered after the scheduled fire time")
      expect(v1Calls[1]!.text).toContain(SchedulerMessage.timestamp(due))
      expect(v1Calls[1]!.text).toContain(SchedulerMessage.timestamp(due).slice(0, 16))

      // On success the schedule advances from the delivery time.
      rows = yield* scheduleRows
      expect(rows).toHaveLength(1)
      expect(rows[0]!.next_fire_at).toBe(due + 3_600_000)
    }),
  )

  it.effect("fired events follow ordinary event-log retention", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_retention")
      yield* makeSession(sessionID)
      yield* seedV2State(sessionID)
      const scheduler = yield* Scheduler.Service

      const added = yield* scheduler.add({ sessionID, message: "prune me", spec: { cron: "0 * * * *" } })
      yield* advance(added.nextFireAt + 1)
      yield* settled
      expect(yield* eventCount(contextUpdatedType)).toBe(1)

      // Nothing scheduler-specific protects the fired event: the ordinary
      // prune floor removes it like any other durable event (R9.2).
      const events = yield* Database.Service.use(({ db }) =>
        db.select().from(EventTable).all().pipe(Effect.orDie),
      )
      const fired = events.find((event) => event.type === contextUpdatedType)
      expect(fired).toBeDefined()
      const { db } = yield* Database.Service
      yield* EventV2.prune(db, [[sessionID, fired!.seq]])
      expect(yield* eventCount(contextUpdatedType)).toBe(0)
    }),
  )

  itStandalone.effect("survives a restart: loads schedules, catches up, and arms the timer", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const dir = yield* Effect.promise(tmpdir)
      const database = `${dir.path}/scheduler-restart.db`
      const dbNode = LayerNode.make({
        service: Database.Service,
        layer: Database.layerFromPath(database),
        deps: [],
      })
      const stack = AppNodeBuilder.build(
        LayerNode.group([dbNode, EventV2.node, SessionProjector.node, SessionV2.node, Scheduler.node, v1promptNode]),
        replacements,
      )
      const inScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const environment = yield* Layer.build(stack)
          return yield* effect.pipe(Effect.provide(environment))
        }).pipe(Effect.scoped)
      const sessionID = SessionV2.ID.make("ses_restart")
      const started = yield* now

      // Phase 1: create the session and a schedule due in one hour.
      yield* inScope(
        Effect.gen(function* () {
          yield* makeSession(sessionID)
          yield* seedV2State(sessionID)
          const scheduler = yield* Scheduler.Service
          const added = yield* scheduler.add({ sessionID, message: "after restart", spec: { cron: "0 * * * *" } })
          expect(added.nextFireAt).toBeGreaterThan(started)
        }),
      )

      // Phase 2: the process is down while the due time passes.
      yield* advance(2 * 3_600_000)
      const deliveredAt = yield* now

      // Phase 3: restart — init loads the persisted schedule and the delivery
      // loop catches up exactly once at the first opportunity.
      yield* inScope(
        Effect.gen(function* () {
          yield* settled
          const scheduler = yield* Scheduler.Service

          expect(yield* scheduler.list(sessionID)).toHaveLength(1)
          expect(yield* eventCount(contextUpdatedType)).toBe(1)
          const session = yield* SessionV2.Service
          const messages = yield* session.messages({ sessionID })
          const text = messages[0]!.type === "system" ? messages[0]!.text : ""
          expect(text).toContain("after restart")
          expect(text).toContain("catch-up: delivered after the scheduled fire time")
          // The catch-up timestamp is the missed occurrence, not the delivery time.
          expect(text).toContain(SchedulerMessage.timestamp(started + 3_600_000))

          // Exactly one catch-up: skipped occurrences are never replayed.
          yield* advance(30 * 60_000)
          yield* settled
          expect(yield* eventCount(contextUpdatedType)).toBe(1)

          // The timer re-armed on the next occurrence after the delivery time.
          yield* advance(31 * 60_000)
          yield* settled
          expect(yield* eventCount(contextUpdatedType)).toBe(2)
          const rows = yield* scheduleRows
          expect(rows[0]!.next_fire_at).toBeGreaterThan(deliveredAt)
        }),
      )
      yield* Effect.promise(() => dir[Symbol.asyncDispose]())
    }),
  )

  itStandalone.effect("catches up a missed one-shot once and removes it", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const dir = yield* Effect.promise(tmpdir)
      const database = `${dir.path}/scheduler-oneshot-restart.db`
      const dbNode = LayerNode.make({
        service: Database.Service,
        layer: Database.layerFromPath(database),
        deps: [],
      })
      const stack = AppNodeBuilder.build(
        LayerNode.group([dbNode, EventV2.node, SessionProjector.node, SessionV2.node, Scheduler.node, v1promptNode]),
        replacements,
      )
      const inScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const environment = yield* Layer.build(stack)
          return yield* effect.pipe(Effect.provide(environment))
        }).pipe(Effect.scoped)
      const sessionID = SessionV2.ID.make("ses_oneshot_restart")
      const started = yield* now

      yield* inScope(
        Effect.gen(function* () {
          yield* makeSession(sessionID)
          yield* seedV2State(sessionID)
          yield* Database.Service.use(({ db }) =>
            db
              .insert(ScheduleTable)
              .values({
                id: ScheduleID.create(),
                session_id: sessionID,
                at: started + 60_000,
                message: "one-shot after restart",
                next_fire_at: started + 60_000,
              })
              .run()
              .pipe(Effect.orDie),
          )
        }),
      )

      yield* advance(2 * 3_600_000)

      yield* inScope(
        Effect.gen(function* () {
          yield* settled
          const session = yield* SessionV2.Service
          const messages = yield* session.messages({ sessionID })
          expect(messages).toHaveLength(1)
          const text = messages[0]!.type === "system" ? messages[0]!.text : ""
          expect(text).toContain("one-shot after restart")
          expect(text).toContain("catch-up: delivered after the scheduled fire time")
          expect(yield* scheduleRows).toEqual([])

          yield* advance(60 * 60_000)
          yield* settled
          expect(yield* eventCount(contextUpdatedType)).toBe(1)
        }),
      )
      yield* Effect.promise(() => dir[Symbol.asyncDispose]())
    }),
  )
})
