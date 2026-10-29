export * as TaskRun from "./task-run"

import { Clock, Context, Effect, Layer, Schema } from "effect"
import { and, desc, eq } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"
import { TaskRunTable } from "./sql"

/**
 * The status of a subagent-run on a status surface (specs/tool-task.md
 * R4.10, R4.11, R5.4): the stored registry state, or `interrupted` for a row
 * stored `running` whose run has no live job in the live-job-registry of the
 * reading process — derived at read time, never written.
 */
export type State = "running" | "completed" | "error" | "cancelled" | "interrupted"

/**
 * The service-side view of a task_run row (specs/tool-task.md Task-run
 * record) as the reads return it: `state` is the derived status of the row —
 * the stored registry state, or `interrupted` for a stored-running run with
 * no live job (R4.10, R4.11), derived at read time through the attached
 * liveness reader and never written. Timestamps are UTC epoch milliseconds;
 * `settledAt` is present only when the stored state left `running`.
 */
export interface Entry {
  readonly id: SessionSchema.ID
  readonly parentSession: SessionSchema.ID
  readonly childSession: SessionSchema.ID
  readonly description: string
  readonly state: State
  readonly createdAt: number
  readonly updatedAt: number
  readonly settledAt: number | null
}

/**
 * The derived state of one row against the live-job-registry of the reading
 * process (R4.10, R4.11): a run with a live job reads `running` regardless
 * of the stored state, a stored `running` row without a live job reads
 * `interrupted`, and a settled stored state reads as stored.
 */
export const deriveState = (stored: State, live: { readonly status: string } | undefined): State => {
  if (live?.status === "running") return "running"
  if (stored === "running") return "interrupted"
  return stored
}

/** No task_run row with this id is bound to the calling session (spec R1.8, R5.12). */
export class NotFound extends Schema.TaggedErrorClass<NotFound>()("TaskRun.NotFound", {
  sessionID: SessionSchema.ID,
  taskID: SessionSchema.ID,
}) {}

/**
 * The continuation capability of the host (specs/tool-task.md R1.7, I6):
 * admits the continuation prompt into the durable subagent session and
 * starts its live job, applying the same liveness decision tree as the task
 * tool. Core declares the capability; hosts provide the implementation
 * because the V1 prompt runtime lives above core — the same topology the
 * scheduler solves with `attachV1Prompt` (specs/scheduler.md I4). The
 * capability is attached to the service with `attachRunner`; before an
 * attach, a continuation via `continue` dies — the host topology is broken,
 * and the HTTP boundary surfaces the defect as `UnknownError`.
 */
/**
 * The liveness reader of the host process (specs/tool-task.md R4.10, R4.11):
 * reports whether a run has a live job in the live-job-registry of the
 * reading process. Core declares the capability; hosts provide the
 * implementation because the live-job registry is instance-scoped above core.
 * Before an attach, `get` and `list` report the stored state only.
 */
export interface Liveness {
  readonly get: (runID: SessionSchema.ID) => Effect.Effect<{ readonly status: string } | undefined>
}

export interface Runner {
  readonly continue: (input: {
    readonly runID: SessionSchema.ID
    readonly parentSession: SessionSchema.ID
    readonly description: string
    readonly message: string
  }) => Effect.Effect<void>
}

export interface Interface {
  readonly attachRunner: (runner: Runner) => Effect.Effect<boolean>
  readonly attachLiveness: (liveness: Liveness) => Effect.Effect<boolean>
  /**
   * Inserts the row of one launched subagent-run with the stored state
   * `running` at launch time (R4.3); `id` must equal the child session id
   * (R4.2).
   */
  readonly launch: (input: {
    readonly id: SessionSchema.ID
    readonly parentSession: SessionSchema.ID
    readonly childSession: SessionSchema.ID
    readonly description: string
  }) => Effect.Effect<void>
  /**
   * Writes the stored state of a settled, failed, or cancelled run and
   * records the settle time (R4.5, R4.6).
   */
  readonly settle: (input: {
    readonly id: SessionSchema.ID
    readonly state: "completed" | "error" | "cancelled"
  }) => Effect.Effect<void>
  /** Re-marks the row of a continued run `running` and clears the settle time (R4.4). */
  readonly markRunning: (id: SessionSchema.ID) => Effect.Effect<void>
  /**
   * The addressed subagent-run of one session with its stored state, or
   * `undefined` when no row of the session carries the id (R5.3). The id is
   * the raw caller input — any value that no row carries resolves to
   * `undefined`. Reads mutate no row (R4.11); the derived `interrupted`
   * reading is applied by the surfaces through `deriveState`.
   */
  readonly get: (sessionID: SessionSchema.ID, taskID: string) => Effect.Effect<Entry | undefined>
  /**
   * Every subagent-run of one session, newest launch first, ties ordered by
   * run id ascending (R5.2), with stored state.
   */
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Entry>>
  /**
   * Resolves the addressed subagent-run of `sessionID` and applies the host
   * continuation for `message` (R5.7); fails with `NotFound` when no row of
   * the session carries the id (R5.12) and performs nothing in that case.
   */
  readonly continue: (input: {
    readonly sessionID: SessionSchema.ID
    readonly taskID: SessionSchema.ID
    readonly message: string
  }) => Effect.Effect<Entry, NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/TaskRun") {}

type Row = typeof TaskRunTable.$inferSelect

const entryOf = (row: Row): Entry => ({
  id: row.id,
  parentSession: row.parent_session,
  childSession: row.child_session,
  description: row.description,
  state: row.state,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  settledAt: row.settled_at,
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db

    let runner: Runner | undefined
    let liveness: Liveness | undefined

    // The derived reading of one stored row against the attached liveness
    // reader (R4.10, R4.11): applied inside the reads, mutating nothing.
    const derivedState = (row: Row) =>
      Effect.gen(function* () {
        const live = liveness ? yield* liveness.get(row.child_session) : undefined
        return deriveState(row.state, live)
      })

    const rawGet = (sessionID: SessionSchema.ID, taskID: string) =>
      db
        .select()
        .from(TaskRunTable)
        .where(and(eq(TaskRunTable.id, taskID as SessionSchema.ID), eq(TaskRunTable.parent_session, sessionID)))
        .get()
        .pipe(Effect.orDie)

    const get: Interface["get"] = Effect.fn("TaskRun.get")(function* (sessionID, taskID) {
      const row = yield* rawGet(sessionID, taskID)
      if (!row) return undefined
      return { ...entryOf(row), state: yield* derivedState(row) }
    })

    return Service.of({
      attachRunner: Effect.fn("TaskRun.attachRunner")(function* (attached) {
        if (runner !== undefined) {
          yield* Effect.logWarning(
            "TaskRun continuation attach refused; this process already holds one — more than one application-services graph was built",
          )
          return false
        }
        runner = attached
        yield* Effect.logInfo("TaskRun continuation runner attached")
        return true
      }),

      launch: Effect.fn("TaskRun.launch")(function* (input) {
        const now = yield* Clock.currentTimeMillis
        yield* db
          .insert(TaskRunTable)
          .values({
            id: input.id,
            parent_session: input.parentSession,
            child_session: input.childSession,
            description: input.description,
            state: "running",
            created_at: now,
            updated_at: now,
            settled_at: null,
          })
          .run()
          .pipe(Effect.orDie)
      }),

      settle: Effect.fn("TaskRun.settle")(function* (input) {
        const now = yield* Clock.currentTimeMillis
        yield* db
          .update(TaskRunTable)
          .set({ state: input.state, settled_at: now, updated_at: now })
          .where(eq(TaskRunTable.id, input.id))
          .run()
          .pipe(Effect.orDie)
      }),

      markRunning: Effect.fn("TaskRun.markRunning")(function* (id) {
        const now = yield* Clock.currentTimeMillis
        yield* db
          .update(TaskRunTable)
          .set({ state: "running", settled_at: null, updated_at: now })
          .where(eq(TaskRunTable.id, id))
          .run()
          .pipe(Effect.orDie)
      }),

      get,

      list: Effect.fn("TaskRun.list")(function* (sessionID) {
        const rows = yield* db
          .select()
          .from(TaskRunTable)
          .where(eq(TaskRunTable.parent_session, sessionID))
          .orderBy(desc(TaskRunTable.created_at), TaskRunTable.id)
          .all()
          .pipe(Effect.orDie)
        return yield* Effect.forEach(rows, (row) =>
          Effect.map(derivedState(row), (state) => ({ ...entryOf(row), state })))
      }),

      attachLiveness: Effect.fn("TaskRun.attachLiveness")(function* (attached) {
        if (liveness !== undefined) {
          yield* Effect.logWarning(
            "TaskRun liveness attach refused; this process already holds one — more than one application-services graph was built",
          )
          return false
        }
        liveness = attached
        yield* Effect.logInfo("TaskRun liveness reader attached")
        return true
      }),

      continue: Effect.fn("TaskRun.continue")(function* (input) {
        const row = yield* rawGet(input.sessionID, input.taskID)
        if (!row) return yield* new NotFound({ sessionID: input.sessionID, taskID: input.taskID })
        // Reaching this branch without an attached runner is a host topology
        // defect: the capability is bound by the V1 runtime's local node, so
        // a process serving this route without it is misassembled. The HTTP
        // boundary reports the defect as UnknownError.
        const bound = runner
        if (!bound) return yield* Effect.die(`TaskRun continuation runner is not attached in this process`)
        yield* bound.continue({
          runID: row.child_session,
          parentSession: row.parent_session,
          description: row.description,
          message: input.message,
        })
        const entry = yield* get(input.sessionID, input.taskID)
        return entry!
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node],
})
