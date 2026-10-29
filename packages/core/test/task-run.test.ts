import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { ProjectSchema } from "@opencode-ai/core/project/schema"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { TaskRun } from "@opencode-ai/core/task-run/task-run"
import { TaskRunTable } from "@opencode-ai/core/task-run/sql"
import { eq } from "drizzle-orm"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const sessionID = (id: string) => SessionSchema.ID.make(`ses_${id}`)

const it = testEffect(
  // Database is listed explicitly: the test bodies seed session rows and read
  // the migration journal directly, not only through the registry service.
  AppNodeBuilder.build(LayerNode.group([TaskRun.node, BackgroundJob.node, Database.node])),
)

/** A real session row so the cascading foreign key has something to point at. */
const seedSession = Effect.fn("TaskRunTest.seedSession")(function* (id: SessionSchema.ID) {
  const database = yield* Database.Service
  const directory = AbsolutePath.make("/repo")
  yield* database.db
    .insert(ProjectTable)
    .values({
      id: ProjectSchema.ID.make("proj_test"),
      worktree: directory,
      sandboxes: [],
      time_created: 1,
      time_updated: 1,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({
      id,
      project_id: ProjectSchema.ID.make("proj_test"),
      slug: "task-run",
      directory,
      title: "task-run",
      version: "test",
      time_created: 1,
      time_updated: 1,
    })
    .run()
    .pipe(Effect.orDie)
})


/** Seeds the child session row (the FK target) and inserts the task_run row. */
const launch = Effect.fn("TaskRunTest.launch")(function* (input: {
  id: SessionSchema.ID
  parentSession: SessionSchema.ID
  description: string
}) {
  yield* seedSession(input.id)
  yield* (yield* TaskRun.Service).launch({
    id: input.id,
    parentSession: input.parentSession,
    childSession: input.id,
    description: input.description,
  })
})


/** The stored row without the derived reading — what the writes actually recorded. */
const rawRow = Effect.fn("TaskRunTest.rawRow")(function* (id: SessionSchema.ID) {
  const database = yield* Database.Service
  return yield* database.db.select().from(TaskRunTable).where(eq(TaskRunTable.id, id)).get().pipe(Effect.orDie)
})

describe("TaskRun registry", () => {
  it.live("launch inserts one running row per subagent session with id equal to the child session id", () =>
    Effect.gen(function* () {
      const taskRun = yield* TaskRun.Service
      const parent = sessionID("parent")
      const child = sessionID("child")

      yield* launch({ id: child, parentSession: parent, description: "fix tests" })
      yield* launch({ id: sessionID("child2"), parentSession: parent, description: "second run" })

      const rows = yield* taskRun.list(parent)
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(row.id).toBe(row.childSession)
        expect(row.parentSession).toBe(parent)
        expect(row.settledAt).toBeNull()
        expect(row.createdAt).toBeGreaterThan(0)
      }
      // The stored rows carry the running state (R4.3); the derived reading
      // of a row without a live job is the dedicated liveness test below.
      const stored = yield* rawRow(sessionID("child"))
      expect(stored?.state).toBe("running")
    }),
  )

  it.live("settle records completed, error, and cancelled states with the settle time", () =>
    Effect.gen(function* () {
      const taskRun = yield* TaskRun.Service
      const parent = sessionID("parent")
      const states = ["completed", "error", "cancelled"] as const
      for (const state of states) {
        const id = sessionID(`run-${state}`)
        yield* launch({ id, parentSession: parent, description: state })
      }
      for (const state of states) {
        yield* taskRun.settle({ id: sessionID(`run-${state}`), state })
      }

      for (const state of states) {
        const row = yield* taskRun.get(parent, sessionID(`run-${state}`))
        expect(row?.state).toBe(state)
        expect(row?.settledAt).toBeGreaterThan(0)
      }
    }),
  )

  it.live("markRunning re-marks a settled row running and clears the settle time", () =>
    Effect.gen(function* () {
      const taskRun = yield* TaskRun.Service
      const parent = sessionID("parent")
      const id = sessionID("continued")
      yield* launch({ id, parentSession: parent, description: "first pass" })
      yield* taskRun.settle({ id, state: "completed" })
      expect((yield* taskRun.get(parent, id))?.state).toBe("completed")

      yield* taskRun.markRunning(id)

      const stored = yield* rawRow(id)
      expect(stored?.state).toBe("running")
      expect(stored?.settled_at).toBeNull()
      expect(stored?.updated_at).toBeGreaterThanOrEqual(stored!.created_at)
    }),
  )

  it.live("list orders newest launch first with id ascending ties", () =>
    Effect.gen(function* () {
      const taskRun = yield* TaskRun.Service
      const database = yield* Database.Service
      const parent = sessionID("parent")
      // Inserted with controlled launch times: the list must re-order newest
      // launch first, and the id-ascending tiebreak orders one instant's pair.
      const rows = [
        { id: sessionID("a"), created: 100, description: "oldest" },
        { id: sessionID("c"), created: 200, description: "middle" },
        { id: sessionID("b"), created: 300, description: "newest" },
        { id: sessionID("t2"), created: 400, description: "tie" },
        { id: sessionID("t1"), created: 400, description: "tie" },
      ]
      for (const row of rows) {
        yield* seedSession(row.id)
        yield* database.db
          .insert(TaskRunTable)
          .values({
            id: row.id,
            parent_session: parent,
            child_session: row.id,
            description: row.description,
            state: "running",
            created_at: row.created,
            updated_at: row.created,
            settled_at: null,
          })
          .run()
          .pipe(Effect.orDie)
      }

      const listed = yield* taskRun.list(parent)
      expect(listed.map((row) => row.id)).toEqual([
        sessionID("t1"),
        sessionID("t2"),
        sessionID("b"),
        sessionID("c"),
        sessionID("a"),
      ])
    }),
  )

  it.live("a run with a live job reads running and a stored running row without one reads interrupted", () =>
    Effect.gen(function* () {
      const taskRun = yield* TaskRun.Service
      const jobs = yield* BackgroundJob.Service
      const parent = sessionID("parent")
      const live = sessionID("live")
      const dead = sessionID("dead")
      yield* launch({ id: live, parentSession: parent, description: "live" })
      yield* launch({ id: dead, parentSession: parent, description: "dead" })

      yield* jobs.start({ id: live, type: "task", run: Effect.never })
      // The host liveness reader reports the live-job registry; the service
      // derives the reading inside its reads (R4.10, R4.11).
      yield* taskRun.attachLiveness({ get: (id) => jobs.get(id) })

      expect((yield* taskRun.get(parent, live))?.state).toBe("running")
      expect((yield* taskRun.get(parent, dead))?.state).toBe("interrupted")

      const before = yield* taskRun.get(parent, dead)
      const after = yield* taskRun.get(parent, dead)
      expect(after).toEqual(before)
      expect(TaskRun.deriveState("running", undefined)).toBe("interrupted")
    }),
  )

  it.live("a second runner or liveness attach is refused", () =>
    Effect.gen(function* () {
      const taskRun = yield* TaskRun.Service
      expect(yield* taskRun.attachLiveness({ get: () => Effect.succeed(undefined) })).toBe(true)
      expect(yield* taskRun.attachLiveness({ get: () => Effect.succeed(undefined) })).toBe(false)
      expect(yield* taskRun.attachRunner({ continue: () => Effect.void })).toBe(true)
      expect(yield* taskRun.attachRunner({ continue: () => Effect.void })).toBe(false)
    }),
  )

  it.live("continue dies when no runner is attached", () =>
    Effect.gen(function* () {
      const taskRun = yield* TaskRun.Service
      const parent = sessionID("parent")
      const id = sessionID("orphan")
      yield* launch({ id, parentSession: parent, description: "orphan" })

      const exit = yield* taskRun.continue({ sessionID: parent, taskID: id, message: "hi" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected a die")
      expect(Cause.hasDies(exit.cause)).toBe(true)
    }),
  )

  it.live("continue fails with NotFound for unknown and foreign task ids and performs nothing", () =>
    Effect.gen(function* () {
      const taskRun = yield* TaskRun.Service
      const parent = sessionID("parent")
      const foreign = sessionID("foreign")
      yield* seedSession(foreign)
      yield* (yield* TaskRun.Service).launch({
        id: foreign,
        parentSession: sessionID("other"),
        childSession: foreign,
        description: "foreign",
      })
      const attached = yield* taskRun.attachRunner({ continue: () => Effect.die("runner must not be called") })
      expect(attached).toBe(true)

      const unknown = yield* taskRun
        .continue({ sessionID: parent, taskID: sessionID("missing"), message: "hi" })
        .pipe(Effect.exit)
      expect(Exit.isFailure(unknown)).toBe(true)
      const foreignCall = yield* taskRun
        .continue({ sessionID: parent, taskID: foreign, message: "hi" })
        .pipe(Effect.exit)
      expect(Exit.isFailure(foreignCall)).toBe(true)
    }),
  )

  it.live("continue delegates to the attached runner and returns the refreshed running entry", () =>
    Effect.gen(function* () {
      const taskRun = yield* TaskRun.Service
      const jobs = yield* BackgroundJob.Service
      const parent = sessionID("parent")
      const id = sessionID("run")
      yield* launch({ id, parentSession: parent, description: "run" })
      yield* taskRun.settle({ id, state: "completed" })

      const seen: Array<{ runID: string; parentSession: string; description: string; message: string }> = []
      yield* taskRun.attachLiveness({ get: (id) => jobs.get(id) })
      yield* taskRun.attachRunner({
        continue: (input) =>
          Effect.gen(function* () {
            seen.push({ ...input })
            // The host runner re-marks the row and starts the live job, as the
            // task engine does before admitting the prompt.
            yield* taskRun.markRunning(input.runID)
            yield* jobs.start({ id: input.runID, type: "task", run: Effect.never })
          }),
      })

      const entry = yield* taskRun.continue({ sessionID: parent, taskID: id, message: "keep going" })
      expect(seen).toEqual([{ runID: id, parentSession: parent, description: "run", message: "keep going" }])
      expect(entry.state).toBe("running")
      expect(entry.settledAt).toBeNull()
    }),
  )

  it.live("rows survive a database reopen and read interrupted after the restart", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const file = `${root.path}/task-run.db`
      const parent = sessionID("parent")
      const id = sessionID("survivor")

      const graph = (filename: string) =>
        AppNodeBuilder.build(LayerNode.group([TaskRun.node, BackgroundJob.node]), [
          [
            Database.node,
            makeGlobalNode({ service: Database.Service, layer: Database.layerFromPath(filename), deps: [] }),
          ],
        ])

      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const taskRun = yield* TaskRun.Service
          yield* launch({ id, parentSession: parent, description: "survivor" })
          yield* taskRun.settle({ id, state: "completed" })
          yield* launch({
            id: sessionID("live-at-shutdown"),
            parentSession: parent,
            description: "died with the process",
          })
          return yield* taskRun.list(parent)
        }).pipe(Effect.provide(graph(file))),
      )
      expect(first).toHaveLength(2)

      // A reopen with no live jobs: settled rows keep their state, and the
      // row that was running at shutdown reads interrupted once the derived
      // reading is applied with no live job (R4.7, R4.12).
      const second = yield* Effect.scoped(
        Effect.gen(function* () {
          const taskRun = yield* TaskRun.Service
          return yield* taskRun.list(parent)
        }).pipe(Effect.provide(graph(file))),
      )
      expect(second.map((row) => [row.id, TaskRun.deriveState(row.state, undefined)])).toEqual([
        [sessionID("live-at-shutdown"), "interrupted"],
        [id, "completed"],
      ])
    }),
  )

  it.live("deleting the subagent session row deletes its task_run row", () =>
    Effect.gen(function* () {
      const taskRun = yield* TaskRun.Service
      const database = yield* Database.Service
      const parent = sessionID("parent")
      const child = sessionID("ephemeral")
      yield* launch({ id: child, parentSession: parent, description: "cascades" })
      expect(yield* taskRun.get(parent, child)).toBeDefined()

      yield* database.db.delete(SessionTable).where(eq(SessionTable.id, child)).run().pipe(Effect.orDie)

      expect(yield* taskRun.get(parent, child)).toBeUndefined()
    }),
  )

  it.live("a fresh database registers task_run through the generated migration pipeline", () =>
    Effect.gen(function* () {
      const taskRun = yield* TaskRun.Service
      const database = yield* Database.Service
      // The layer applied the generated migration pipeline on the empty
      // database; the table and its journal entry exist.
      const table = yield* database.db
        .get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_run'`)
        .pipe(Effect.orDie)
      expect(table?.name).toBe("task_run")
      const journal = yield* database.db
        .get<{ id: string }>(sql`SELECT id FROM migration WHERE id = '20261028225350_add_task_run_table'`)
        .pipe(Effect.orDie)
      expect(journal?.id).toBe("20261028225350_add_task_run_table")

      const parent = sessionID("parent")
      yield* launch({ id: sessionID("after-migration"), parentSession: parent, description: "usable" })
      expect(yield* taskRun.list(parent)).toHaveLength(1)
    }),
  )
})
