import { describe, expect } from "bun:test"
import fs from "fs/promises"
import { realpathSync } from "node:fs"
import { Clock, Deferred, Duration, Effect, Fiber, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"
import { Database } from "@opencode-ai/core/database/database"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SchedulerGate } from "@opencode-ai/core/scheduler/gate"
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

type GateCall = { readonly command: string; readonly directory: string }
const gateCalls: GateCall[] = []
const gateBehavior = {
  // Exit codes consumed one per run; a run beyond the list exits zero.
  exitCodes: [] as number[],
  // Combined outputs consumed one per run; a run beyond the list writes
  // nothing.
  outputs: [] as string[],
  // Programmed per run, the run blocks until the deferred succeeds — the
  // in-flight probe of the gate phase.
  holds: [] as Deferred.Deferred<void>[],
}
// The fake command-execution layer replaces the process command runner at
// the I8 boundary: unit tests record invocations and program exit codes
// instead of spawning real processes.
const gate = Layer.effect(
  SchedulerGate.Service,
  Effect.succeed(
    SchedulerGate.Service.of({
      run: (input) =>
        Effect.suspend(() => {
          gateCalls.push({ command: input.command, directory: input.directory })
          const result = { exitCode: gateBehavior.exitCodes.shift() ?? 0, output: gateBehavior.outputs.shift() ?? "" }
          const hold = gateBehavior.holds.shift()
          return hold === undefined ? Effect.succeed(result) : Effect.as(Deferred.await(hold), result)
        }),
    }),
  ),
)

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
                  name: "from the turn",
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
const replacements = [
  [SessionExecution.node, execution],
  [SchedulerGate.node, gate],
] as const
// The real-spawn tests build their own stack without the gate replacement:
// the production runner spawns actual `bash -c` invocations.
const replacementsWithoutGate = [[SessionExecution.node, execution]] as const

// The spawn-failure variant of the fake gate: the underlying invocation
// fails — a run that cannot spawn — and the gate resolves the failure to the
// substituted exit status exactly like the production runner (gate.ts,
// Error handling).
const spawnFailureGate = Layer.succeed(
  SchedulerGate.Service,
  SchedulerGate.Service.of({
    run: (input) =>
      Effect.suspend(() => {
        gateCalls.push({ command: input.command, directory: input.directory })
        return Effect.catch(
          Effect.fail(new Error("injected spawn failure")),
          () => Effect.succeed({ exitCode: SchedulerGate.SPAWN_FAILURE_EXIT_CODE, output: "" }),
        )
      }),
  }),
)
const replacementsWithSpawnFailureGate = [
  [SessionExecution.node, execution],
  [SchedulerGate.node, spawnFailureGate],
] as const

const it = testEffect(AppNodeBuilder.build(nodes, replacements))
// Restart-style tests manage their own stacks over a file-backed database;
// the ambient layer stays empty.
const itStandalone = testEffect(Layer.empty)
// The spawn-failure record test swaps the fake gate for its spawn-failure
// variant.
const itSpawnFailure = testEffect(AppNodeBuilder.build(nodes, replacementsWithSpawnFailureGate))

const makeSession = (sessionID: SessionV2.ID, directory: string = "/project") =>
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
          directory,
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

// A BEFORE UPDATE trigger on the schedule table RAISEs — the injection seam
// for a defect in the fire's serialized finish phase: the finish's row
// update dies exactly like a broken database would, while the reads and the
// admission stay healthy.
const armFinishFailure = Database.Service.use(({ db }) =>
  db
    .run(sql`CREATE TRIGGER schedule_finish_failure BEFORE UPDATE ON schedule BEGIN SELECT RAISE(ABORT, 'injected finish failure'); END`)
    .pipe(Effect.orDie),
)

const disarmFinishFailure = Database.Service.use(({ db }) =>
  db.run(sql`DROP TRIGGER schedule_finish_failure`).pipe(Effect.orDie),
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
  gateCalls.length = 0
  gateBehavior.exitCodes.length = 0
  gateBehavior.outputs.length = 0
  gateBehavior.holds.length = 0
})

const now = Clock.currentTimeMillis
const advance = (millis: number) => TestClock.adjust(Duration.millis(millis))

const settled = Effect.gen(function* () {
  yield* Effect.yieldNow
  yield* Effect.yieldNow
})

// Drains the longer async chain a resolved gate-run walks: run continuation,
// delivery bookkeeping, held mark, loop wake, and the follow-up fire.
const flushed = Effect.gen(function* () {
  yield* settled
  yield* settled
  yield* settled
})

// Polls a real file in real time — for tests whose gate-run spawns a real
// process under the virtual clock.
const waitForFile = (file: string) =>
  Effect.promise(async () => {
    while (true) {
      try {
        return await fs.readFile(file, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
    }
  })

// Polls in real time until the effect holds — for chains whose continuation
// resumes on a real async callback (a spawned process), which the virtual
// clock's yield rounds cannot wait for.
const eventually = <R>(
  effect: Effect.Effect<boolean, never, R>,
): Effect.Effect<void, never, R> =>
  Effect.flatMap(effect, (holds) =>
    holds
      ? Effect.void
      : Effect.flatMap(Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10))), () =>
          eventually(effect),
        ),
  )

// The diagnostic log record of a suppressed fire (R6.19): the default logger
// writes one console.log entry per record — a header carrying the level, the
// record text carrying the marker, and the annotations object — and the
// TestConsole of the harness flattens those parameters into logLines.
const suppressionRecords = Effect.map(TestConsole.logLines, (lines) => {
  const records: { readonly header: string; readonly text: string; readonly annotations: Record<string, unknown> }[] =
    []
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index]
    if (typeof text === "string" && text.includes(Scheduler.SUPPRESSION_LOG_MARKER)) {
      records.push({
        header: lines[index - 1] as string,
        text,
        annotations: lines[index + 1] as Record<string, unknown>,
      })
    }
  }
  return records
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
        name: "check CI status",
        spec: { cron: "*/30 * * * *" },
      })
      const oneShot = yield* scheduler.add({
        sessionID,
        message: "ship it",
        name: "ship it",
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

      const added = yield* scheduler.add({ sessionID: owner, message: "secret plan", name: "secret plan", spec: { cron: "0 12 * * *" } })

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
        .add({ sessionID: capped, message: "one too many", name: "one too many", spec: { cron: "0 0 * * *" } })
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
        name: "fiftieth",
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
      yield* scheduler.add({ sessionID, message: "remember me", name: "remember me", spec: { cron: "0 0 * * *" } })
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
      // The nullable gate-command column registers through the same
      // generated pipeline (D-003, R4.3).
      expect(migrations.some((migration) => migration.id.endsWith("_add_schedule_command"))).toBe(true)
      // So does the nullable display-name column (R4.3).
      expect(migrations.some((migration) => migration.id.endsWith("_add_schedule_name"))).toBe(true)
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
        name: "check CI status",
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
      const added = yield* scheduler.add({ sessionID, message: "standup", name: "standup", spec: { cron: "0 0 * * *" } })
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
        name: "deploy",
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
        name: "v1 reminder",
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

      const added = yield* scheduler.add({ sessionID: ghost, message: "anyone?", name: "anyone?", spec: { cron: "* * * * *" } })
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

      const added = yield* scheduler.add({ sessionID, message: "once", name: "once", spec: { cron: "0 * * * *" } })
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

      const first = yield* scheduler.add({ sessionID, message: "first", name: "first", spec: { cron: "* * * * *" } })
      const second = yield* scheduler.add({ sessionID, message: "second", name: "second", spec: { cron: "* * * * *" } })
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
        .add({ sessionID, message: "third", name: "third", spec: { cron: "* * * * *" } })
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
      const added = yield* scheduler.add({ sessionID, message: "fires", name: "fires", spec: { cron: "* * * * *" } })
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
      const added = yield* scheduler.add({ sessionID, message: "slow", name: "slow", spec: { cron: "0 * * * *" } })
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

      const added = yield* scheduler.add({ sessionID, message: "persistent", name: "persistent", spec: { cron: "0 * * * *" } })
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

      const added = yield* scheduler.add({ sessionID, message: "prune me", name: "prune me", spec: { cron: "0 * * * *" } })
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
          const added = yield* scheduler.add({ sessionID, message: "after restart", name: "after restart", spec: { cron: "0 * * * *" } })
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

  it.effect("stores and returns the name on rows and entries, reading legacy rows as null", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_name_store")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service

      const named = yield* scheduler.add({
        sessionID,
        message: "check CI status",
        name: "CI check",
        spec: { cron: "0 * * * *" },
      })
      expect(named.name).toBe("CI check")

      // A row created before the field existed carries no name (the Schedule
      // record): direct SQL insert with the column left out, read back as
      // null through the service (T1.9's storage counterpart).
      const legacy = ScheduleID.create()
      const dueAt = (yield* now) + 60_000
      yield* Database.Service.use(({ db }) =>
        db
          .insert(ScheduleTable)
          .values({
            id: legacy,
            session_id: sessionID,
            cron: "0 * * * *",
            message: "legacy row",
            next_fire_at: dueAt,
          })
          .run()
          .pipe(Effect.orDie),
      )
      const stored = yield* Database.Service.use(({ db }) =>
        db.select().from(ScheduleTable).all().pipe(Effect.orDie),
      )
      expect(stored.map((row) => row.name)).toContain(null)
      const listed = yield* scheduler.list(sessionID)
      expect(listed.find((entry) => entry.id === named.id)!.name).toBe("CI check")
      expect(listed.find((entry) => entry.id === legacy)!.name).toBeNull()
    }),
  )

  it.effect("stores and returns the gate command on rows and entries", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_store")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service

      const gated = yield* scheduler.add({
        sessionID,
        message: "gated",
        name: "gated",
        spec: { cron: "0 * * * *" },
        command: "test -f done.flag",
      })
      const plain = yield* scheduler.add({ sessionID, message: "plain", name: "plain", spec: { cron: "0 * * * *" } })

      const rows = yield* scheduleRows
      expect(rows.find((row) => row.id === gated.id)!.command).toBe("test -f done.flag")
      expect(rows.find((row) => row.id === plain.id)!.command).toBeNull()
      const listed = yield* scheduler.list(sessionID)
      expect(listed.find((entry) => entry.id === gated.id)!.command).toBe("test -f done.flag")
      expect(listed.find((entry) => entry.id === plain.id)!.command).toBeNull()
    }),
  )

  it.effect("runs the gate before any delivery side effect and delivers on a zero exit", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_zero")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service
      const hold = yield* Deferred.make<void>()
      gateBehavior.exitCodes.push(0)
      gateBehavior.outputs.push("  build 1234 passed \n")
      gateBehavior.holds.push(hold)

      const added = yield* scheduler.add({
        sessionID,
        message: "check CI status",
        name: "check CI status",
        spec: { cron: "0 * * * *" },
        command: "curl -sf http://ci.local/passed",
      })
      yield* advance(added.nextFireAt + 1)
      yield* settled

      // The run is in flight: invoked with the stored text and the session
      // directory (R6.17, R6.18), but no delivery side effect happened yet
      // (R6.12) — no admission, no event (R5.5: the run asks nothing).
      expect(gateCalls).toEqual([{ command: "curl -sf http://ci.local/passed", directory: "/project" }])
      expect(v1Calls).toEqual([])
      expect(wakeCalls).toEqual([])

      // Zero exit delivers, the trimmed output riding the section (R6.13, R6.14).
      yield* Deferred.succeed(hold, undefined)
      yield* flushed
      expect(v1Calls).toHaveLength(1)
      expect(v1Calls[0]!.text).toContain(`fired schedule id ${added.id} 0 * * * *: check CI status`)
      expect(v1Calls[0]!.text).toContain("\ngate command output:\nbuild 1234 passed")
      expect(v1Calls[0]!.text.endsWith("build 1234 passed")).toBe(true)

      // The schedule advanced from the discharged time.
      const rows = yield* scheduleRows
      expect(rows).toHaveLength(1)
      expect(rows[0]!.next_fire_at).toBe(added.nextFireAt + 3_600_000)
    }),
  )

  it.effect("appends and truncates the gate output section, and skips it when empty", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_output")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service
      gateBehavior.exitCodes.push(0, 0)
      gateBehavior.outputs.push("x".repeat(SchedulerMessage.MAX_GATE_OUTPUT_LENGTH + 5), "  \n\t ")

      const added = yield* scheduler.add({
        sessionID,
        message: "watch output",
        name: "watch output",
        spec: { cron: "0 * * * *" },
        command: "emit",
      })
      yield* advance(added.nextFireAt + 1)
      yield* settled
      expect(v1Calls).toHaveLength(1)
      // Truncation caps the trimmed output at the bound with an ellipsis (R6.14).
      expect(v1Calls[0]!.text).toContain(
        `\ngate command output:\n${"x".repeat(SchedulerMessage.MAX_GATE_OUTPUT_LENGTH)}…`,
      )
      expect(v1Calls[0]!.text.endsWith("…")).toBe(true)

      // The next fire's run writes nothing: no section at all (R6.14).
      yield* advance(3_600_000)
      yield* settled
      expect(v1Calls).toHaveLength(2)
      expect(v1Calls[1]!.text).not.toContain("gate command output")
      expect(v1Calls[1]!.text.endsWith("watch output")).toBe(true)
    }),
  )

  it.effect("suppresses a recurring fire on a nonzero exit and advances from the discharged time", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_suppress")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service
      gateBehavior.exitCodes.push(1)

      const added = yield* scheduler.add({
        sessionID,
        message: "check flag",
        name: "check flag",
        spec: { cron: "0 * * * *" },
        command: "test -f done.flag",
      })
      yield* advance(added.nextFireAt + 1)
      yield* settled

      // Nothing was delivered; the occurrence discharged (R6.15).
      expect(gateCalls).toHaveLength(1)
      expect(v1Calls).toEqual([])
      expect(yield* eventCount(contextUpdatedType)).toBe(0)
      const rows = yield* scheduleRows
      expect(rows[0]!.next_fire_at).toBe(added.nextFireAt + 3_600_000)

      // A suppressed fire is not a delivery failure: the loop retries
      // nothing (R8.10, R8.11).
      yield* advance(Scheduler.RETRY_DELAY_MILLIS + 1)
      yield* settled
      expect(gateCalls).toHaveLength(1)
    }),
  )

  it.effect("removes a one-shot whose gate exits nonzero", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_oneshot")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service
      gateBehavior.exitCodes.push(7)

      const added = yield* scheduler.add({
        sessionID,
        message: "deploy",
        name: "deploy",
        spec: { at: (yield* now) + 60_000 },
        command: "test -f ready.flag",
      })
      yield* advance(added.nextFireAt + 1)
      yield* settled

      // Removed silently: no fire ever appeared (R6.16).
      expect(gateCalls).toHaveLength(1)
      expect(v1Calls).toEqual([])
      expect(yield* scheduleRows).toEqual([])
    }),
  )

  it.effect("fires commandless schedules unchanged", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_commandless")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service

      const added = yield* scheduler.add({ sessionID, message: "plain reminder", name: "plain reminder", spec: { cron: "0 * * * *" } })
      expect(added.command).toBeNull()
      yield* advance(added.nextFireAt + 1)
      yield* settled

      // R6.11: no gate-run at all, and the fired text is the plain grammar.
      expect(gateCalls).toEqual([])
      expect(v1Calls).toHaveLength(1)
      expect(v1Calls[0]!.text).toBe(
        `${SchedulerMessage.timestamp(added.nextFireAt)} fired schedule id ${added.id} 0 * * * *: plain reminder`,
      )
      const rows = yield* scheduleRows
      expect(rows[0]!.next_fire_at).toBe(added.nextFireAt + 3_600_000)
    }),
  )

  it.effect("processes a held occurrence as a catch-up fire after the run resolves", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_held")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service
      const hold = yield* Deferred.make<void>()
      gateBehavior.exitCodes.push(0, 0)
      gateBehavior.outputs.push("first run out", "held run out")
      gateBehavior.holds.push(hold)

      const added = yield* scheduler.add({ sessionID, message: "hold me", name: "hold me", spec: { cron: "0 * * * *" }, command: "wait" })
      const due = added.nextFireAt
      yield* advance(due + 1)
      yield* settled
      expect(gateCalls).toHaveLength(1)

      // The next occurrence passes while the run is in flight: no second
      // run starts (R8.7, R8.8).
      yield* advance(90 * 60_000)
      yield* settled
      expect(gateCalls).toHaveLength(1)
      expect(v1Calls).toEqual([])

      // The run resolves: its fire delivers unmarked, and the held
      // occurrence follows with its own run as a catch-up fire (R8.9, E8.9).
      yield* Deferred.succeed(hold, undefined)
      yield* flushed
      expect(gateCalls).toHaveLength(2)
      expect(v1Calls).toHaveLength(2)
      expect(v1Calls[0]!.text).toContain(SchedulerMessage.timestamp(due))
      expect(v1Calls[0]!.text).not.toContain("catch-up")
      expect(v1Calls[0]!.text).toContain("\ngate command output:\nfirst run out")
      expect(v1Calls[1]!.text).toContain(SchedulerMessage.timestamp(due + 3_600_000))
      expect(v1Calls[1]!.text).toContain("catch-up: delivered after the scheduled fire time")
      expect(v1Calls[1]!.text).toContain("\ngate command output:\nheld run out")

      // The catch-up advanced from its delivery time (R7.4): the next full
      // hour after the resolution.
      const rows = yield* scheduleRows
      expect(rows[0]!.next_fire_at).toBe(due + 2 * 3_600_000)
    }),
  )

  it.effect("advances a suppressed held occurrence from the gate resolution time", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_held_suppressed")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service
      const hold = yield* Deferred.make<void>()
      gateBehavior.exitCodes.push(0, 1)
      gateBehavior.holds.push(hold)

      const added = yield* scheduler.add({ sessionID, message: "slow check", name: "slow check", spec: { cron: "0 * * * *" }, command: "wait" })
      const due = added.nextFireAt
      yield* advance(due + 1)
      yield* settled
      yield* advance(90 * 60_000)
      yield* Deferred.succeed(hold, undefined)
      yield* flushed

      // The first fire delivered; the held occurrence's own run was
      // suppressed (R6.13): the series discharged, advancing from the
      // resolution time (R7.9), with no second delivery.
      expect(gateCalls).toHaveLength(2)
      expect(v1Calls).toHaveLength(1)
      const rows = yield* scheduleRows
      expect(rows[0]!.next_fire_at).toBe(due + 2 * 3_600_000)
    }),
  )

  it.effect("keeps serving other schedules and mutations while a gate-run is in flight", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_others")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service
      const hold = yield* Deferred.make<void>()
      gateBehavior.exitCodes.push(0)
      gateBehavior.holds.push(hold)

      const gated = yield* scheduler.add({ sessionID, message: "gated", name: "gated", spec: { cron: "0 * * * *" }, command: "wait" })
      yield* advance(gated.nextFireAt + 1)
      yield* settled
      expect(gateCalls).toHaveLength(1)

      // The commandless schedule due later fires mid-flight; its slot also
      // keeps the gated fire's post-fire advance in the future, so only the
      // two fires below happen.
      const plain = yield* scheduler.add({ sessionID, message: "plain", name: "plain", spec: { cron: "30 * * * *" } })
      expect(plain.nextFireAt).toBeGreaterThan(gated.nextFireAt)
      // TestClock advances are relative: move from the already-reached
      // gated due time to the plain one.
      yield* advance(plain.nextFireAt - gated.nextFireAt)
      yield* settled

      // The gated run is still in flight; the commandless schedule due
      // later delivered on time (R8.6, E8.6).
      expect(gateCalls).toHaveLength(1)
      expect(v1Calls).toHaveLength(1)
      expect(v1Calls[0]!.text).toContain("plain")

      // A concurrent mutation proceeded without waiting for the run.
      const addFiber = yield* scheduler
        .add({ sessionID, message: "mid-flight", name: "mid-flight", spec: { cron: "0 0 * * *" } })
        .pipe(Effect.forkScoped)
      yield* settled
      const midFlight = yield* Fiber.join(addFiber)
      expect(midFlight.message).toBe("mid-flight")

      yield* Deferred.succeed(hold, undefined)
      yield* flushed
      expect(v1Calls).toHaveLength(2)
      expect(v1Calls[1]!.text).toContain("gated")
    }),
  )

  it.effect("drops a schedule removed while its gate-run is in flight", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_removed")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service
      const hold = yield* Deferred.make<void>()
      gateBehavior.holds.push(hold)

      const added = yield* scheduler.add({ sessionID, message: "vanish", name: "vanish", spec: { cron: "0 * * * *" }, command: "wait" })
      const due = added.nextFireAt
      yield* advance(due + 1)
      yield* settled
      expect(gateCalls).toHaveLength(1)
      expect(v1Calls).toEqual([])

      // The schedule is removed while its gate-run hangs in flight.
      const removed = yield* scheduler.remove({ sessionID, id: added.id })
      expect(removed.id).toBe(added.id)

      // The run resolves into a removed row: no delivery, no second run,
      // and no row left behind.
      yield* Deferred.succeed(hold, undefined)
      yield* flushed
      expect(gateCalls).toHaveLength(1)
      expect(v1Calls).toEqual([])
      expect(yield* scheduleRows).toEqual([])

      // The machine is clean: a follow-up schedule fires unmarked on time —
      // the fiber released the row and nudged the timer.
      const later = yield* scheduler.add({ sessionID, message: "later", name: "later", spec: { cron: "30 * * * *" } })
      yield* advance(later.nextFireAt - due)
      yield* flushed
      expect(gateCalls).toHaveLength(1)
      expect(v1Calls).toHaveLength(1)
      expect(v1Calls[0]!.text).toContain("later")
      expect(v1Calls[0]!.text).not.toContain("catch-up")
      const rows = yield* scheduleRows
      expect(rows[0]!.next_fire_at).toBeGreaterThan(later.nextFireAt)
    }),
  )

  it.effect("does not retry a suppressed fire", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_no_retry")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service
      gateBehavior.exitCodes.push(1, 1)

      const added = yield* scheduler.add({
        sessionID,
        message: "event check",
        name: "event check",
        spec: { cron: "0 * * * *" },
        command: "check",
      })
      const due = added.nextFireAt
      yield* advance(due + 1)
      yield* settled
      expect(gateCalls).toHaveLength(1)
      expect(v1Calls).toEqual([])

      // E8.10: no delivery-failure marking, no retry cadence.
      yield* advance(Scheduler.RETRY_DELAY_MILLIS * 10)
      yield* settled
      expect(gateCalls).toHaveLength(1)

      // The schedule next runs its gate at the next occurrence.
      yield* advance(3_600_000 - Scheduler.RETRY_DELAY_MILLIS * 10)
      yield* settled
      expect(gateCalls).toHaveLength(2)
      expect(v1Calls).toEqual([])
      const rows = yield* scheduleRows
      expect(rows[0]!.next_fire_at).toBe(due + 2 * 3_600_000)
    }),
  )

  it.effect("writes one suppression record on a nonzero gate exit", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_suppress_record")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service
      gateBehavior.exitCodes.push(3)

      const added = yield* scheduler.add({
        sessionID,
        message: "check flag",
        name: "check flag",
        spec: { cron: "0 * * * *" },
        command: "test -f done.flag",
      })
      yield* advance(added.nextFireAt + 1)
      yield* flushed

      // T6.16: exactly one diagnostic record — the marker rides the text,
      // the schedule id and the exit status ride the annotations, at level
      // info (R6.19).
      const records = yield* suppressionRecords
      expect(records).toHaveLength(1)
      expect(records[0]!.header).toContain("INFO")
      expect(records[0]!.text).toContain(Scheduler.SUPPRESSION_LOG_MARKER)
      expect(records[0]!.annotations).toEqual({
        scheduleID: added.id,
        gateExitCode: 3,
        spawnFailure: false,
      })
      // The suppression stays a silent non-delivery otherwise (R8.10).
      expect(v1Calls).toEqual([])
    }),
  )

  itSpawnFailure.effect("writes one suppression record on a spawn failure", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_spawn_record")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service

      const added = yield* scheduler.add({
        sessionID,
        message: "unspawnable",
        name: "unspawnable",
        spec: { cron: "0 * * * *" },
        command: "check",
      })
      yield* advance(added.nextFireAt + 1)
      yield* flushed

      // T6.17: exactly one record — the failed run resolves to
      // SCHEDULER_GATE_SPAWN_FAILURE_EXIT_CODE, and the record names the
      // spawn-failure outcome (R6.19).
      const records = yield* suppressionRecords
      expect(records).toHaveLength(1)
      expect(records[0]!.header).toContain("INFO")
      expect(records[0]!.text).toContain(Scheduler.SUPPRESSION_LOG_MARKER)
      expect(records[0]!.annotations).toEqual({
        scheduleID: added.id,
        gateExitCode: SchedulerGate.SPAWN_FAILURE_EXIT_CODE,
        spawnFailure: true,
      })
      expect(v1Calls).toEqual([])
      // The occurrence discharged like any suppression (R6.15).
      const rows = yield* scheduleRows
      expect(rows[0]!.next_fire_at).toBe(added.nextFireAt + 3_600_000)
    }),
  )

  it.effect("writes no suppression record on the delivered paths", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_no_suppress_record")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service
      gateBehavior.exitCodes.push(0)

      // A gated schedule with a permitting gate and a commandless schedule:
      // both fires deliver.
      const gated = yield* scheduler.add({
        sessionID,
        message: "permitted",
        name: "permitted",
        spec: { at: (yield* now) + 60_000 },
        command: "check",
      })
      const plain = yield* scheduler.add({
        sessionID,
        message: "plain",
        name: "plain",
        spec: { at: (yield* now) + 120_000 },
      })
      yield* advance(gated.nextFireAt + 1)
      yield* settled
      expect(v1Calls).toHaveLength(1)
      yield* advance(plain.nextFireAt - gated.nextFireAt)
      yield* settled
      expect(v1Calls).toHaveLength(2)

      // Delivered fires write no suppression record (R6.19 covers
      // suppressed fires only).
      expect(yield* suppressionRecords).toEqual([])
    }),
  )

  it.effect("retries a gated fire whose admission failed as a catch-up", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_admission_fail")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service
      // The gate permits the fire, but the V1 admission fails once.
      v1Behavior.failuresLeft = 1
      gateBehavior.exitCodes.push(0, 0)
      gateBehavior.outputs.push("", "retry out")

      const added = yield* scheduler.add({
        sessionID,
        message: "admission check",
        name: "admission check",
        spec: { cron: "0 * * * *" },
        command: "check",
      })
      const due = added.nextFireAt
      yield* advance(due + 1)
      yield* flushed

      // The gate ran and permitted, but the delivery failed: the row stays
      // due (R8.5).
      expect(gateCalls).toHaveLength(1)
      expect(v1Calls).toHaveLength(1)
      let rows = yield* scheduleRows
      expect(rows[0]!.next_fire_at).toBe(due)

      // The retry re-runs the gate and delivers as a catch-up fire (R7.1).
      yield* advance(Scheduler.RETRY_DELAY_MILLIS + 1)
      yield* flushed
      expect(gateCalls).toHaveLength(2)
      expect(v1Calls).toHaveLength(2)
      expect(v1Calls[1]!.text).toContain("catch-up: delivered after the scheduled fire time")
      expect(v1Calls[1]!.text).toContain(SchedulerMessage.timestamp(due))
      expect(v1Calls[1]!.text).toContain("\ngate command output:\nretry out")
      rows = yield* scheduleRows
      expect(rows[0]!.next_fire_at).toBe(due + 3_600_000)
    }),
  )

  it.effect("retries a gated fire whose finish failed as a catch-up", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const sessionID = SessionV2.ID.make("ses_gate_finish_fail")
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service
      // The gate permits the fire, the V1 admission succeeds, and the
      // serialized finish's row update dies once.
      yield* armFinishFailure
      gateBehavior.exitCodes.push(0, 0, 0)

      const added = yield* scheduler.add({
        sessionID,
        message: "finish check",
        name: "finish check",
        spec: { cron: "0 * * * *" },
        command: "check",
      })
      const due = added.nextFireAt
      yield* advance(due + 1)
      yield* flushed

      // The finish died after the admission: the row stays due (R8.5) and
      // the fiber finalized — the row left the in-flight set, so its retry
      // can be scanned like any other due row.
      expect(gateCalls).toHaveLength(1)
      expect(v1Calls).toHaveLength(1)
      let rows = yield* scheduleRows
      expect(rows[0]!.next_fire_at).toBe(due)

      // The retry re-runs the gate and finishes as a catch-up fire (R7.1).
      yield* disarmFinishFailure
      yield* advance(Scheduler.RETRY_DELAY_MILLIS + 1)
      yield* flushed
      expect(gateCalls).toHaveLength(2)
      expect(v1Calls).toHaveLength(2)
      expect(v1Calls[1]!.text).toContain("catch-up: delivered after the scheduled fire time")
      expect(v1Calls[1]!.text).toContain(SchedulerMessage.timestamp(due))
      rows = yield* scheduleRows
      expect(rows[0]!.next_fire_at).toBe(due + 3_600_000)

      // The machine is clean (R8.7, R8.9, R8.11): the next occurrence runs
      // its gate and delivers unmarked — no leftover held mark, no in-flight
      // skip.
      yield* advance(3_600_000 + 1)
      yield* flushed
      expect(gateCalls).toHaveLength(3)
      expect(v1Calls).toHaveLength(3)
      expect(v1Calls[2]!.text).not.toContain("catch-up")
      expect(v1Calls[2]!.text).toContain(SchedulerMessage.timestamp(due + 3_600_000))
      rows = yield* scheduleRows
      expect(rows[0]!.next_fire_at).toBe(due + 2 * 3_600_000)
    }),
  )

  itStandalone.effect("retries a gated fire whose admission is missing as a catch-up", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const dir = yield* Effect.promise(tmpdir)
      // No V1 prompt admission node in the stack, and no V2 state for the
      // session: the resolved fire has nowhere to be admitted (R8.5).
      const stack = AppNodeBuilder.build(
        LayerNode.group([
          LayerNode.make({
            service: Database.Service,
            layer: Database.layerFromPath(`${dir.path}/gate-no-admission.db`),
            deps: [],
          }),
          EventV2.node,
          SessionProjector.node,
          SessionV2.node,
          Scheduler.node,
        ]),
        replacements,
      )
      const inScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const environment = yield* Layer.build(stack)
          return yield* effect.pipe(Effect.provide(environment))
        }).pipe(Effect.scoped)
      const sessionID = SessionV2.ID.make("ses_gate_no_admission")

      yield* inScope(
        Effect.gen(function* () {
          yield* makeSession(sessionID)
          const scheduler = yield* Scheduler.Service
          gateBehavior.exitCodes.push(0, 0)
          const added = yield* scheduler.add({
            sessionID,
            message: "nowhere to go",
            name: "nowhere to go",
            spec: { cron: "0 * * * *" },
            command: "check",
          })
          const due = added.nextFireAt

          yield* advance(due + 1)
          yield* flushed
          // The gate ran and resolved, but the delivery failed: the row
          // stays due, neither advanced nor removed (R8.5).
          expect(gateCalls).toHaveLength(1)
          expect(v1Calls).toEqual([])
          let rows = yield* scheduleRows
          expect(rows[0]!.next_fire_at).toBe(due)

          // The retry re-runs the gate and fails the same way; a failed
          // delivery's retry is a catch-up fire (R7.1), never a hot loop.
          yield* advance(Scheduler.RETRY_DELAY_MILLIS + 1)
          yield* flushed
          expect(gateCalls).toHaveLength(2)
          rows = yield* scheduleRows
          expect(rows[0]!.next_fire_at).toBe(due)
        }),
      )
      yield* Effect.promise(() => dir[Symbol.asyncDispose]())
    }),
  )

  itStandalone.effect("runs the gate once for a whole skipped catch-up series after a restart", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const dir = yield* Effect.promise(tmpdir)
      const stack = AppNodeBuilder.build(
        LayerNode.group([
          LayerNode.make({
            service: Database.Service,
            layer: Database.layerFromPath(`${dir.path}/gate-restart.db`),
            deps: [],
          }),
          EventV2.node,
          SessionProjector.node,
          SessionV2.node,
          Scheduler.node,
          v1promptNode,
        ]),
        replacements,
      )
      const inScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const environment = yield* Layer.build(stack)
          return yield* effect.pipe(Effect.provide(environment))
        }).pipe(Effect.scoped)
      const sessionID = SessionV2.ID.make("ses_gate_restart")
      const started = yield* now

      yield* inScope(
        Effect.gen(function* () {
          yield* makeSession(sessionID)
          yield* seedV2State(sessionID)
          const scheduler = yield* Scheduler.Service
          gateBehavior.exitCodes.push(0)
          gateBehavior.outputs.push("series out")
          yield* scheduler.add({ sessionID, message: "after downtime", name: "after downtime", spec: { cron: "0 * * * *" }, command: "check" })
        }),
      )
      const due = started + 3_600_000

      // The process is down while hours of occurrences pass.
      yield* advance(4 * 3_600_000)

      // Restart: exactly one gate-run for the entire skipped series (R7.7),
      // delivering one marked catch-up fire with the section (E7.7).
      yield* inScope(
        Effect.gen(function* () {
          yield* flushed
          expect(gateCalls).toHaveLength(1)
          expect(yield* eventCount(contextUpdatedType)).toBe(1)
          const session = yield* SessionV2.Service
          const messages = yield* session.messages({ sessionID })
          const text = messages[0]!.type === "system" ? messages[0]!.text : ""
          expect(text).toContain("after downtime")
          expect(text).toContain("catch-up: delivered after the scheduled fire time")
          expect(text).toContain(SchedulerMessage.timestamp(due))
          expect(text).toContain("\ngate command output:\nseries out")

          // The catch-up advanced from the delivery time (R7.4); skipped
          // occurrences are never replayed (R7.5).
          const rows = yield* scheduleRows
          expect(rows[0]!.next_fire_at).toBe(due + 4 * 3_600_000)
          yield* advance(30 * 60_000)
          yield* flushed
          expect(yield* eventCount(contextUpdatedType)).toBe(1)
        }),
      )
      yield* Effect.promise(() => dir[Symbol.asyncDispose]())
    }),
  )

  itStandalone.effect("discharges a suppressed catch-up series without replay after a restart", () =>
    Effect.gen(function* () {
      yield* resetRecordings
      const dir = yield* Effect.promise(tmpdir)
      const stack = AppNodeBuilder.build(
        LayerNode.group([
          LayerNode.make({
            service: Database.Service,
            layer: Database.layerFromPath(`${dir.path}/gate-suppressed-restart.db`),
            deps: [],
          }),
          EventV2.node,
          SessionProjector.node,
          SessionV2.node,
          Scheduler.node,
          v1promptNode,
        ]),
        replacements,
      )
      const inScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const environment = yield* Layer.build(stack)
          return yield* effect.pipe(Effect.provide(environment))
        }).pipe(Effect.scoped)
      const sessionID = SessionV2.ID.make("ses_gate_restart_suppressed")
      const started = yield* now

      yield* inScope(
        Effect.gen(function* () {
          yield* makeSession(sessionID)
          yield* seedV2State(sessionID)
          const scheduler = yield* Scheduler.Service
          gateBehavior.exitCodes.push(1)
          yield* scheduler.add({ sessionID, message: "still down", name: "still down", spec: { cron: "0 * * * *" }, command: "check" })
        }),
      )
      const due = started + 3_600_000

      yield* advance(4 * 3_600_000)

      // Restart: the series runs one gate, exits nonzero, and discharges
      // without any delivery (R7.7, R7.8).
      yield* inScope(
        Effect.gen(function* () {
          yield* flushed
          expect(gateCalls).toHaveLength(1)
          expect(yield* eventCount(contextUpdatedType)).toBe(0)
          // R7.9: the advance starts at the gate resolution time — hours
          // after the scheduled fire time, not at it.
          const rows = yield* scheduleRows
          expect(rows[0]!.next_fire_at).toBe(due + 4 * 3_600_000)

          // The series is gone: no replay, no hot loop (R7.8, R8.11).
          yield* advance(30 * 60_000)
          yield* flushed
          expect(gateCalls).toHaveLength(1)
          expect(yield* eventCount(contextUpdatedType)).toBe(0)
        }),
      )
      yield* Effect.promise(() => dir[Symbol.asyncDispose]())
    }),
  )

  if (process.platform !== "win32") {
    itStandalone.effect("executes the gate as bash -c in the session directory", () =>
      Effect.gen(function* () {
        yield* resetRecordings
        const dir = yield* Effect.promise(tmpdir)
        const stack = AppNodeBuilder.build(
          LayerNode.group([
            LayerNode.make({
              service: Database.Service,
              layer: Database.layerFromPath(`${dir.path}/gate-bash.db`),
              deps: [],
            }),
            EventV2.node,
            SessionProjector.node,
            SessionV2.node,
            Scheduler.node,
            v1promptNode,
          ]),
          replacementsWithoutGate,
        )
        const inScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const environment = yield* Layer.build(stack)
            return yield* effect.pipe(Effect.provide(environment))
          }).pipe(Effect.scoped)
        const sessionID = SessionV2.ID.make("ses_gate_bash")
        const marker = `${dir.path}/gate-evidence.txt`

        yield* inScope(
          Effect.gen(function* () {
            yield* makeSession(sessionID, dir.path)
            const scheduler = yield* Scheduler.Service
            const added = yield* scheduler.add({
              sessionID,
              message: "bash check",
              name: "bash check",
              spec: { cron: "0 * * * *" },
              command: `printf '%s\\n' "$PWD|$BASH_VERSION" > ${JSON.stringify(marker)}`,
            })

            yield* advance(added.nextFireAt + 1)
            // The run executes for real; its evidence lands in the session
            // directory.
            const evidence = yield* waitForFile(marker)
            const [cwd, bashVersion] = evidence.trim().split("|")
            // R6.18: the working directory is the location directory of the
            // owning session.
            expect(realpathSync(cwd!)).toBe(realpathSync(dir.path))
            // R6.17: the interpreter is bash, whatever the host default is.
            expect(bashVersion!.length > 0).toBe(true)

            // The zero exit delivered the fire — its continuation resumes on
            // the real spawn callback, so wait in real time.
            yield* eventually(
              Effect.gen(function* () {
                yield* settled
                return v1Calls.length === 1
              }),
            )
            expect(v1Calls[0]!.text).toContain("bash check")
          }),
        )
        yield* Effect.promise(() => dir[Symbol.asyncDispose]())
      }),
    )

    itStandalone.effect("suppresses a fire whose gate cannot spawn", () =>
      Effect.gen(function* () {
        yield* resetRecordings
        const dir = yield* Effect.promise(tmpdir)
        const stack = AppNodeBuilder.build(
          LayerNode.group([
            LayerNode.make({
              service: Database.Service,
              layer: Database.layerFromPath(`${dir.path}/gate-spawn-fail.db`),
              deps: [],
            }),
            EventV2.node,
            SessionProjector.node,
            SessionV2.node,
            Scheduler.node,
            v1promptNode,
          ]),
          replacementsWithoutGate,
        )
        const inScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const environment = yield* Layer.build(stack)
            return yield* effect.pipe(Effect.provide(environment))
          }).pipe(Effect.scoped)
        const sessionID = SessionV2.ID.make("ses_gate_spawn_fail")

        yield* inScope(
          Effect.gen(function* () {
            // The session directory does not exist on disk: the invocation
            // cannot spawn and counts as a nonzero exit (Error handling).
            yield* makeSession(sessionID)
            const scheduler = yield* Scheduler.Service
            const added = yield* scheduler.add({
              sessionID,
              message: "unspawnable",
              name: "unspawnable",
              spec: { cron: "0 * * * *" },
              command: "true",
            })

            yield* advance(added.nextFireAt + 1)
            // The spawn fails on a real async callback; wait in real time
            // for the suppression bookkeeping.
            yield* eventually(
              Effect.gen(function* () {
                yield* settled
                const rows = yield* scheduleRows
                return rows[0] !== undefined && rows[0]!.next_fire_at === added.nextFireAt + 3_600_000
              }),
            )
            // Suppressed: no delivery, and the occurrence discharged (R6.13, R6.15).
            expect(v1Calls).toEqual([])
          }),
        )
        yield* Effect.promise(() => dir[Symbol.asyncDispose]())
      }),
    )
  }
})
