export * as Scheduler from "./scheduler"

import { Cause, Clock, Context, DateTime, Effect, Exit, Layer, Schema, Semaphore, Scope } from "effect"
import { and, asc, eq, lte, notInArray } from "drizzle-orm"
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
import { ScheduleID } from "./schema"
import { ScheduleTable } from "./sql"
import { SchedulerCron } from "./cron"
import { SchedulerGate } from "./gate"
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
 * Command length bound in characters (specs/scheduler.md Configuration
 * SCHEDULER_MAX_COMMAND_LENGTH). A longer `command` fails validation
 * (R3.13). Baked constant by design (J6).
 */
export const MAX_COMMAND_LENGTH = 4096

/**
 * Name length bound in characters (specs/scheduler.md Configuration
 * SCHEDULER_MAX_NAME_LENGTH). A longer `name` fails validation (R3.14).
 * Baked constant by design (J6).
 */
export const MAX_NAME_LENGTH = 32

/**
 * Marker naming the scheduler/suppressed-fire in its diagnostic log record
 * (specs/scheduler.md Configuration SCHEDULER_SUPPRESSION_LOG_MARKER). The
 * marker rides the record text (I12); the record's severity is the level of
 * SCHEDULER_SUPPRESSION_LOG_LEVEL, emitted as `Effect.logInfo`.
 */
export const SUPPRESSION_LOG_MARKER = "suppressed"

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
 * `name` is the stored display name shown in the session sidebar, `null` on
 * a legacy row created before the field existed; `command` is the stored
 * scheduler/gate-command text, `null` when the schedule stores no gate;
 * `nextFireAt` is the stored next-due-time in UTC epoch milliseconds;
 * `timeCreated`/`timeUpdated` are the shared timestamp columns.
 */
export interface Entry {
  readonly id: ScheduleID
  readonly sessionID: SessionSchema.ID
  readonly spec: Spec
  readonly name: string | null
  readonly message: string
  readonly command: string | null
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
 *   layer is a defect), for `{ at }` the given instant. `name` is the display
 *   name of the schedule, stored as given (R1.4) — its non-empty/length
 *   validation belongs to the tool, like the message. `command`, when
 *   given, is stored as the scheduler/gate-command text of the schedule
 *   (R6.12); an add without `command` stores no gate and fires exactly as
 *   before (R6.11). Fails with `CapReached` when the session already holds
 *   the cap (R2.4); the permission ask and the argument validation belong to
 *   the tool, not here.
 * - `remove` deletes the schedule with `id` bound to `sessionID` and returns
 *   the removed entry; fails with `NotFound` — foreign or unknown ids
 *   remove nothing (R2.3).
 * - `list` returns every schedule bound to `sessionID`, ordered by id
 *   (R2.2); reads take no part in the loop's serialization.
 * - Gate runs (R6.12-R6.18, I8-I11): a fire of a schedule with a stored
 *   command runs the command through the scheduler/gate runner before any
 *   delivery side effect. The run executes outside the delivery loop's
 *   write permit on a fiber of its own (I9), so the loop keeps serving
 *   mutations and other schedules while it is in flight (R8.6); at most one
 *   run per schedule is in flight (R8.7), the due scan and the timer arm
 *   skip the in-flight row (I11), and a due time reached while the run is
 *   in flight starts no second run (R8.9) — after the run resolves it is
 *   processed as a catch-up fire (R7.1 third disjunct, R8.9). A zero exit
 *   delivers the fire, appending the scheduler/gate-output-section when the
 *   run wrote output (R6.13, R6.14); a nonzero exit — spawn failure or
 *   signal death included (Error handling) — suppresses it: one diagnostic
 *   log record (R6.19), no delivery side effect, no retry, no
 *   delivery-failure marking (R8.10, R8.11), the occurrence discharges
 *   (R6.15, R7.9; a one-shot is removed, R6.16). A
 *   catch-up fire runs the gate exactly once for its entire skipped series
 *   (R7.7) and a suppressed one discharges the series (R7.8).
 * - `attachV1Prompt` binds the host's V1 prompt admission capability (I4);
 *   the first attach wins and later attaches fail softly. Until an attach,
 *   a V1-routed fire fails and retries (R8.5), which also covers processes
 *   without a V1 runtime. The capability rides an attach instead of a layer
 *   dependency because the V1 prompt path depends on the tool registry,
 *   which registers the scheduler tool — a dependency edge would close a
 *   layer cycle.
 * - All schedule-row mutations and fire bookkeeping serialize through the
 *   single delivery loop (R8.3, I6): at init the loop loads every persisted
 *   schedule, arms its timer at the earliest stored next-due-time, re-arms on
 *   every add, remove, fire, and reload (R8.4, R8.2), and delivers a fire
 *   when the current time reaches the next-due-time (R6.2) — publishing,
 *   admitting, and only then advancing or removing the row (I6). The V1
 *   model turn a fire triggers runs outside the loop's write permit — only
 *   its durable admission and the row advance/removal serialize — so a
 *   scheduler tool call from inside that turn cannot self-deadlock the loop.
 *   A failed delivery
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
    readonly name: string
    readonly spec: Spec
    readonly command?: string
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
  name: row.name,
  message: row.message,
  command: row.command,
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
    // The process command runner of the host application-services graph
    // (I4, I8) — executes every scheduler/gate-run (R6.17, R6.18).
    const gate = yield* SchedulerGate.Service
    // The scope gate fibers fork into (I9, I10): in-flight runs live in
    // process memory only and are forgotten when the service dies.
    const scope = yield* Scope.Scope

    // The host's V1 prompt admission (I4); unset until attached, in which
    // case a V1-routed fire fails and retries (R8.5).
    let v1Prompt: SchedulerV1Prompt.Interface | undefined

    // Diagnostic identity of this service instance (R8.1): one process must
    // hold exactly one scheduler/service. Two different instance ids in one
    // process mean the host built a second application-services graph — the
    // logs below date that topology failure.
    const instance = crypto.randomUUID().slice(0, 8)
    const identity = { schedulerInstance: instance, pid: process.pid }

    const loadedAt = yield* Clock.currentTimeMillis
    // Serializes tool mutations with fire deliveries (R8.3, I6).
    const writes = yield* Semaphore.make(1)
    // Nudges the timer on every mutation and fire (R8.4).
    const wake = yield* Semaphore.make(0)
    // Schedule ids whose last delivery attempt failed; their retries are
    // catch-up fires (R7.1) and their rows stay due until success (R8.5).
    const failedDeliveries = new Set<string>()
    // Schedule ids with a gate-run in flight — at most one per schedule
    // (R8.7). The due scan and the timer arm skip these rows (I11): the
    // run's fiber owns the fire until it resolves.
    const gateInFlight = new Set<ScheduleID>()
    // Schedule ids whose next occurrence passed while a gate-run was in
    // flight; their next fire is a catch-up fire (R7.1 third disjunct,
    // R8.9). In-memory only, like the in-flight set (I10).
    const gateHeld = new Set<string>()

    /**
     * The fire a gate-run serves: the row snapshot taken at initiation, the
     * discharged occurrence's scheduled-fire-time bookkeeping, the command
     * text, and the working directory (the owning session's location
     * directory, R6.18).
     */
    type GateStart = {
      readonly phase: "gate"
      readonly row: Row
      readonly catchUp: boolean
      readonly command: string
      readonly directory: string
    }

    /** A V1-routed fire awaiting its permit-free admission. */
    type FireAdmission = {
      readonly phase: "deliver"
      readonly row: Row
      readonly catchUp: boolean
      readonly text: string
      readonly prompt: SchedulerV1Prompt.Interface
    }

    const earliest = Effect.fn("Scheduler.earliest")(function* () {
      // I11: the timer arm skips schedules with an in-flight gate-run —
      // their fiber owns the fire and re-arms the timer through the wake.
      const skip = [...gateInFlight]
      const row = yield* db
        .select({ nextFireAt: ScheduleTable.next_fire_at })
        .from(ScheduleTable)
        .where(skip.length > 0 ? notInArray(ScheduleTable.id, skip) : undefined)
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

    /**
     * The serialized final phase of a fire (I6): advance or remove only
     * after the fire resolved. Serves both outcomes of a gated fire
     * (R6.13): a delivered fire passes the delivery completion time, a
     * suppressed fire the gate-run resolution time — the discharge rule is
     * the same (R6.8; a catch-up fire advances from the observed time,
     * R7.4/R7.9; a one-shot is removed, R6.9/R6.16). The output of a
     * suppressed fire was discarded by the caller; nothing here retries it
     * (R8.10, R8.11).
     */
    const finishFire = Effect.fn("Scheduler.finishFire")(function* (input: {
      readonly row: Row
      readonly catchUp: boolean
      /** Delivery completion time of a delivered fire; gate-run resolution time of a suppressed fire. */
      readonly deliveredAt: number
    }) {
      failedDeliveries.delete(input.row.id)

      if (input.row.cron !== null) {
        // R6.8 / R7.4: a normal fire advances from the discharged time, a
        // catch-up fire from the delivery completion time — a delivery slower
        // than the interval must not produce an immediate unmarked extra fire.
        const advanceFrom = input.catchUp ? input.deliveredAt : input.row.next_fire_at
        const expression = SchedulerCron.parse(input.row.cron)
        const next = expression === undefined ? undefined : SchedulerCron.next(expression, advanceFrom)
        if (next === undefined) {
          yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, input.row.id)).run().pipe(Effect.orDie)
          yield* Effect.logWarning("Scheduler removed a schedule whose cron has no future match").pipe(
            Effect.annotateLogs({ scheduleID: input.row.id, cron: input.row.cron }),
          )
          return
        }
        yield* db
          .update(ScheduleTable)
          .set({ next_fire_at: next })
          .where(eq(ScheduleTable.id, input.row.id))
          .run()
          .pipe(Effect.orDie)
        return
      }
      // R6.9: a one-shot is removed after its delivered fire.
      yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, input.row.id)).run().pipe(Effect.orDie)
    })

    /**
     * The serialized first phase of a fire (R8.3, I6): resolves the owning
     * session, drops the schedule of a dead session (R6.10), determines the
     * catch-up flag, and routes the fire. A schedule with a stored
     * gate-command returns a gate start — the command runs before any
     * delivery side effect (R6.12), outside the write permit (I9). A
     * commandless schedule behaves exactly as before: a V2-routed fire is
     * delivered completely under the permit hold — publish, admit-only
     * admission, wake, and row advance/removal — while a V1-routed fire
     * cannot finish here: its admission may carry a full host model turn
     * (see `deliver`), so this phase returns the admission inputs instead.
     * Returns `undefined` when the fire finished under the hold or the
     * schedule was dropped.
     */
    const startFire = Effect.fn("Scheduler.startFire")(function* (row: Row) {
      // The due scan runs without the permit, so the row may have been
      // removed since; a removed schedule never fires.
      const present = yield* db
        .select({ id: ScheduleTable.id })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, row.id))
        .get()
        .pipe(Effect.orDie)
      if (present === undefined) return undefined

      const session = yield* store.get(row.session_id)
      if (session === undefined) {
        // R6.10: a fire whose owning session no longer exists removes the
        // schedule and delivers nothing — a log line, no event.
        yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, row.id)).run().pipe(Effect.orDie)
        failedDeliveries.delete(row.id)
        yield* Effect.logWarning("Scheduler dropped a schedule whose session no longer exists").pipe(
          Effect.annotateLogs({ scheduleID: row.id, sessionID: row.session_id }),
        )
        return undefined
      }

      // R7.1: a catch-up fire — the scheduled fire time precedes the
      // service load, a delivery failed before, or the occurrence was
      // reached while a gate-run of this schedule was in flight (the mark
      // left by the gate fiber, consumed here).
      const held = gateHeld.delete(row.id)
      const catchUp = row.next_fire_at < loadedAt || failedDeliveries.has(row.id) || held

      if (row.command !== null) {
        return {
          phase: "gate",
          row,
          catchUp,
          command: row.command,
          directory: session.location.directory,
        } as const
      }

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
        yield* finishFire({ row, catchUp, deliveredAt: yield* Clock.currentTimeMillis })
        return undefined
      }

      // R6.5: one synthetic user text part through the V1 prompt path.
      if (v1Prompt === undefined) {
        return yield* new SchedulerV1Prompt.Error({
          detail: "no V1 prompt admission is attached to the scheduler",
        })
      }
      return { phase: "deliver", row, catchUp, text, prompt: v1Prompt } as const
    })

    /**
     * The serialized continuation of a resolved gate-run (I9): the resolved
     * fire re-enters the write permit for its delivery bookkeeping. A
     * nonzero exit — spawn failure and signal death included (Error
     * handling) — suppresses the fire: the diagnostic record of R6.19 is
     * written, no delivery side effect happens, the output is discarded,
     * and the occurrence discharges through `finishFire` (R6.13, R6.15,
     * R6.16; a catch-up fire advances from the resolution time, R7.9). A
     * zero exit builds the fired text with the gate-output-section (R6.14)
     * and routes it like `startFire` does. Returns the V1 admission inputs,
     * or `undefined` when the fire finished under the hold, was suppressed,
     * or the schedule was removed while the run was in flight — a removed
     * schedule never fires.
     */
    const resolveGateFire = Effect.fn("Scheduler.resolveGateFire")(function* (
      started: GateStart,
      result: SchedulerGate.Result,
      resolvedAt: number,
    ) {
      const present = yield* db
        .select({ id: ScheduleTable.id })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, started.row.id))
        .get()
        .pipe(Effect.orDie)
      if (present === undefined) return undefined

      if (result.exitCode !== 0) {
        // R6.19: exactly one diagnostic record per suppression — the marker
        // rides the text (I12), the gate-run exit status and the
        // spawn-failure outcome (SCHEDULER_GATE_SPAWN_FAILURE_EXIT_CODE)
        // ride the annotations. The record emits from the serialized finish
        // path, so it never duplicates and never blocks the loop.
        yield* Effect.logInfo(`Scheduler ${SUPPRESSION_LOG_MARKER} a gated fire`).pipe(
          Effect.annotateLogs({
            scheduleID: started.row.id,
            gateExitCode: result.exitCode,
            spawnFailure: result.exitCode === SchedulerGate.SPAWN_FAILURE_EXIT_CODE,
          }),
        )
        yield* finishFire({ row: started.row, catchUp: started.catchUp, deliveredAt: resolvedAt })
        return undefined
      }

      const specForm = SchedulerMessage.spec({ cron: started.row.cron ?? undefined, at: started.row.at ?? undefined })
      const text = SchedulerMessage.fired({
        scheduledFireAt: started.row.next_fire_at,
        id: started.row.id,
        spec: specForm,
        message: started.row.message,
        catchUp: started.catchUp,
        gateOutput: result.output,
      })

      if (yield* servedByV2(started.row.session_id)) {
        yield* events.publish(SessionEvent.ContextUpdated, {
          sessionID: started.row.session_id,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          text,
        })
        yield* sessions.prompt({ sessionID: started.row.session_id, prompt: { text }, resume: false })
        yield* execution.wake(started.row.session_id)
        yield* finishFire({ row: started.row, catchUp: started.catchUp, deliveredAt: yield* Clock.currentTimeMillis })
        return undefined
      }

      if (v1Prompt === undefined) {
        return yield* new SchedulerV1Prompt.Error({
          detail: "no V1 prompt admission is attached to the scheduler",
        })
      }
      return { phase: "deliver", row: started.row, catchUp: started.catchUp, text, prompt: v1Prompt } as const
    })

    /**
     * R8.5 bookkeeping for a failed delivery attempt, shared by the
     * delivery loop and the gate fiber: the row stays due and the retry
     * surfaces as a catch-up fire (R7.1).
     */
    const markDeliveryFailure = Effect.fn("Scheduler.markDeliveryFailure")(function* (
      row: Row,
      cause: Cause.Cause<unknown>,
    ) {
      failedDeliveries.add(row.id)
      yield* Effect.logError("Scheduler delivery failed; the schedule stays due").pipe(
        Effect.annotateLogs({ scheduleID: row.id, sessionID: row.session_id, cause: Cause.pretty(cause) }),
      )
    })

    /**
     * The fiber body of one gated fire (I9): runs the gate command holding
     * no write permit — the delivery loop keeps serving mutations and other
     * schedules meanwhile (R8.6) — then re-enters the serialized path for
     * the fire's bookkeeping. Every failure is captured here, so the fiber
     * never fails. After the fire completes, a due time held by the
     * in-flight run is marked so the next fire is a catch-up fire (R8.9,
     * R7.1 third disjunct), and the timer is nudged (R8.4) — the loop may
     * be parked on the wake while this row was the only due schedule.
     */
    const gateFire = Effect.fn("Scheduler.gateFire")(function* (started: GateStart) {
      const result = yield* gate.run({ command: started.command, directory: started.directory })
      const resolvedAt = yield* Clock.currentTimeMillis
      let completed = true
      const resolved = yield* writes.withPermits(1)(resolveGateFire(started, result, resolvedAt)).pipe(Effect.exit)
      if (Exit.isFailure(resolved)) {
        completed = false
        yield* markDeliveryFailure(started.row, resolved.cause)
      } else if (resolved.value !== undefined) {
        const admitted = yield* resolved.value.prompt
          .prompt({ sessionID: resolved.value.row.session_id, text: resolved.value.text })
          .pipe(Effect.exit)
        if (Exit.isSuccess(admitted)) {
          // A defect in the finish must not strand the row in-flight (R8.7):
          // it is captured like an admission failure — the row stays due and
          // the retry is a catch-up fire (R8.5, R7.1) — so the fiber always
          // reaches its finalization below.
          const finished = yield* writes.withPermits(1)(
            finishFire({
              row: resolved.value.row,
              catchUp: resolved.value.catchUp,
              deliveredAt: yield* Clock.currentTimeMillis,
            }),
          ).pipe(Effect.exit)
          if (Exit.isFailure(finished)) {
            completed = false
            yield* markDeliveryFailure(resolved.value.row, finished.cause)
          }
        } else {
          completed = false
          yield* markDeliveryFailure(resolved.value.row, admitted.cause)
        }
      }
      if (!completed) {
        // A failed delivery retries on the loop's cadence (R8.5): the fiber
        // holds the row in-flight while it waits out the retry delay, so
        // the wake below cannot hand a still-due row straight back to the
        // scan — that would hot-loop the gate.
        yield* Effect.sleep(RETRY_DELAY_MILLIS)
      } else {
        // The finish above advanced the row, so an already-past
        // next-due-time is an occurrence that was reached while the run was
        // in flight. Marked before the row leaves the in-flight set — the
        // due scan must never deliver it unmarked.
        const row = yield* db
          .select({ cron: ScheduleTable.cron, nextFireAt: ScheduleTable.next_fire_at })
          .from(ScheduleTable)
          .where(eq(ScheduleTable.id, started.row.id))
          .get()
          .pipe(Effect.orDie)
        const now = yield* Clock.currentTimeMillis
        if (row !== undefined && row.cron !== null && row.nextFireAt <= now) gateHeld.add(started.row.id)
      }
      gateInFlight.delete(started.row.id)
      yield* wake.release(1)
    })

    /**
     * Delivers one due schedule row. The serialized phases of the fire hold
     * the write permit (R8.3, I6); the gate-run of a gated fire and the V1
     * admission between the phases do not: the gate-run may execute
     * arbitrarily long (SCHEDULER_GATE_TIMEOUT none) and the admission may
     * carry a full host model turn (SessionPrompt.prompt runs the turn
     * including tool execution), and a scheduler tool call inside that turn
     * re-enters `add`/`remove`, which wait for the same permit — holding
     * the permit across either would self-deadlock the delivery loop. The
     * gate-run further runs on a fiber of its own, so the loop keeps
     * serving other schedules while it is in flight (R8.6).
     */
    const deliver = Effect.fn("Scheduler.deliver")(function* (row: Row) {
      const started = yield* writes.withPermits(1)(startFire(row))
      if (started === undefined) return
      if (started.phase === "gate") {
        // R8.7 single-flight: the row joins the in-flight set before the
        // fiber is forked — the due scan and the timer arm skip it until
        // the run resolves (I11).
        gateInFlight.add(started.row.id)
        yield* gateFire(started).pipe(Effect.forkIn(scope, { startImmediately: true }))
        return
      }
      yield* started.prompt.prompt({ sessionID: row.session_id, text: started.text })
      // The delivery completes with the admission; the model turn it started
      // may still be running.
      const deliveredAt = yield* Clock.currentTimeMillis
      yield* writes.withPermits(1)(finishFire({ row, catchUp: started.catchUp, deliveredAt }))
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
        // I11: the in-flight run's fiber owns this row.
        if (gateInFlight.has(row.id)) continue
        const attempt = yield* deliver(row).pipe(Effect.exit)
        if (Exit.isSuccess(attempt)) continue
        // R8.5: the schedule is neither advanced nor removed; the retry is a
        // catch-up fire (R7.1).
        failed = true
        yield* markDeliveryFailure(row, attempt.cause)
      }
      return failed
    })

    const runLoop = Effect.forever(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const next = yield* earliest()
        if (next === undefined) yield* wake.take(1)
        else yield* Effect.race(wake.take(1), Effect.sleep(Math.max(0, next - now)))
        const failed = yield* deliverDue()
        if (failed) yield* Effect.sleep(RETRY_DELAY_MILLIS)
      }),
    )
    yield* Effect.logInfo("Scheduler delivery loop started").pipe(Effect.annotateLogs(identity))
    yield* runLoop.pipe(Effect.forkScoped)

    return Service.of({
      attachV1Prompt: Effect.fn("Scheduler.attachV1Prompt")(function* (attached) {
        if (v1Prompt !== undefined) {
          // A second admission binding reaching this instance means the host
          // built a second SchedulerV1PromptLocal graph node in this process
          // (R8.1); the binding is refused softly, but the topology is broken.
          yield* Effect.logWarning(
            "Scheduler V1 prompt admission attach refused; this process already holds one — more than one application-services graph was built",
          ).pipe(Effect.annotateLogs(identity))
          return false
        }
        v1Prompt = attached
        yield* Effect.logInfo("Scheduler V1 prompt admission attached").pipe(Effect.annotateLogs(identity))
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
              name: input.name,
              message: input.message,
              command: input.command ?? null,
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
  deps: [Database.node, EventV2.node, SessionV2.node, SessionStore.node, SessionExecution.node, SchedulerGate.node],
})
