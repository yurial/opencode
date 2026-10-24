import { afterEach, describe, expect } from "bun:test"
import { Cause, Clock, Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Scheduler } from "@opencode-ai/core/scheduler/scheduler"
import { ScheduleID } from "@opencode-ai/core/scheduler/schema"
import { ScheduleTable } from "@opencode-ai/core/scheduler/sql"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "../../src/tool/truncate"
import { SchedulerTool } from "../../src/tool/scheduler"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set<SessionV2.ID>()),
    resume: () => Effect.void,
    interrupt: () => Effect.void,
    wake: () => Effect.void,
  }),
)

const root = LayerNode.group([
  Database.node,
  EventV2Bridge.node,
  SessionProjector.node,
  SessionStore.node,
  SessionV2.node,
  Scheduler.node,
  LSP.node,
  FSUtil.node,
  Format.node,
  Truncate.node,
  Agent.node,
])
const replacements = [[SessionExecution.node, execution]] as const

const it = testEffect(AppNodeBuilder.build(root, replacements))
// Tool execution resolves the agent for output truncation, which needs the
// ambient instance context: these tests run inside a tmpdir instance.

afterEach(async () => {
  await disposeAllInstances()
})

type Ask = { readonly permission: string; readonly patterns: readonly string[] }
const asks: Ask[] = []
const deny = { denied: false }

const ctx = (sessionID: SessionID): Tool.Context => ({
  sessionID,
  messageID: MessageID.make("msg_scheduler_test"),
  callID: "",
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: (request) =>
    Effect.suspend(() => {
      asks.push({ permission: request.permission, patterns: request.patterns })
      // The V1 ask flow surfaces a denial through the ctx.ask die channel.
      if (deny.denied) return Effect.die(new PermissionV1.DeniedError({ ruleset: [] }))
      return Effect.void
    }),
})

const init = Effect.fn("SchedulerToolTest.init")(function* () {
  const info = yield* SchedulerTool
  return yield* info.init()
})

/** Returns the model-facing error message of a failed call (execute errors are terminal). */
const fail = Effect.fn("SchedulerToolTest.fail")(function* (args: Record<string, unknown>, sessionID: SessionID) {
  const tool = yield* init()
  const exit = yield* tool.execute(args as never, ctx(sessionID)).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause)
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(`expected the scheduler tool call to fail, got: ${JSON.stringify(exit)}`)
})

const run = Effect.fn("SchedulerToolTest.run")(function* (args: Record<string, unknown>, sessionID: SessionID) {
  const tool = yield* init()
  return yield* tool.execute(args as never, ctx(sessionID))
})

const makeSession = (sessionID: SessionID) =>
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

/** Clears schedule rows so tests stay isolated over the shared file database. */
const freshSchedules = Database.Service.use(({ db }) => db.delete(ScheduleTable).run().pipe(Effect.orDie))

const rowsFor = (sessionID: SessionID) =>
  Database.Service.use(({ db }) =>
    db.select().from(ScheduleTable).where(eq(ScheduleTable.session_id, sessionID)).all().pipe(Effect.orDie),
  )

const seedSchedules = (sessionID: SessionID, count: number, nextFireAt: number) =>
  Database.Service.use(({ db }) =>
    Effect.forEach(
      Array.from({ length: count }, (_, index) => index),
      (index) =>
        db
          .insert(ScheduleTable)
          .values({
            id: ScheduleID.make(`sch_seed_${index}_${sessionID.slice(4, 12)}`),
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

let sessionCounter = 0
const nextSession = () => SessionID.make(`ses_scheduler_tool_${++sessionCounter}`)

describe("scheduler tool", () => {
  it.instance("exposes the scheduler tool id", () =>
    Effect.gen(function* () {
      expect(SchedulerTool.id).toBe("scheduler")
    }),
  )

  it.instance("returns invalid-arguments when args fail schema decode", () =>
    Effect.gen(function* () {
      yield* freshSchedules
      const sessionID = nextSession()
      yield* makeSession(sessionID)

      expect(yield* fail({ action: "destroy" }, sessionID)).toContain("invalid arguments")
      expect(yield* fail({ action: "add", every: 30, message: "m" }, sessionID)).toContain("invalid arguments")
      expect(yield* fail({ action: "remove" }, sessionID)).toContain("invalid arguments")

      expect(yield* rowsFor(sessionID)).toEqual([])
    }),
  )

  it.instance("add echoes the id, the converted spec, and the next due time", () =>
    Effect.gen(function* () {
      yield* freshSchedules
      const sessionID = nextSession()
      yield* makeSession(sessionID)

      const result = yield* run({ action: "add", every: "30m", message: "check CI status" }, sessionID)
      expect(result.metadata).toMatchObject({ action: "add" })
      expect(result.output).toMatch(/sch_[A-Za-z0-9]+/)
      expect(result.output).toContain("*/30 * * * *")
      expect(result.output).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/)

      const rows = yield* rowsFor(sessionID)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.cron).toBe("*/30 * * * *")
      expect(rows[0]!.at).toBeNull()
      expect(rows[0]!.message).toBe("check CI status")
    }),
  )

  it.instance("list carries one line per schedule of the calling session", () =>
    Effect.gen(function* () {
      yield* freshSchedules
      const sessionID = nextSession()
      const stranger = nextSession()
      yield* makeSession(sessionID)
      yield* makeSession(stranger)
      const scheduler = yield* Scheduler.Service
      yield* scheduler.add({ sessionID, message: "first thing", spec: { cron: "*/30 * * * *" } })
      yield* scheduler.add({ sessionID, message: "second thing", spec: { cron: "0 12 * * *" } })
      yield* scheduler.add({ sessionID: stranger, message: "not mine", spec: { cron: "0 0 * * *" } })

      const result = yield* run({ action: "list" }, sessionID)
      const lines = result.output.split("\n").filter((line) => line.length > 0)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain("*/30 * * * *")
      expect(lines[0]).toContain("first thing")
      expect(lines[1]).toContain("0 12 * * *")
      expect(lines[1]).toContain("second thing")
      expect(result.output).not.toContain("not mine")

      const empty = yield* run({ action: "list" }, nextSession())
      expect(empty.output).toBe("")
    }),
  )

  it.instance("remove confirms the removed id and rejects foreign ids", () =>
    Effect.gen(function* () {
      yield* freshSchedules
      const sessionID = nextSession()
      const stranger = nextSession()
      yield* makeSession(sessionID)
      yield* makeSession(stranger)
      const scheduler = yield* Scheduler.Service
      const added = yield* scheduler.add({ sessionID, message: "mine", spec: { cron: "0 0 * * *" } })

      expect(yield* fail({ action: "remove", id: added.id }, stranger)).toContain("schedule-not-found")
      expect(yield* rowsFor(sessionID)).toHaveLength(1)

      const result = yield* run({ action: "remove", id: added.id }, sessionID)
      expect(result.output).toContain(added.id)
      expect(yield* rowsFor(sessionID)).toEqual([])
    }),
  )

  it.instance("rejects spec conflicts and malformed specs", () =>
    Effect.gen(function* () {
      yield* freshSchedules
      const sessionID = nextSession()
      yield* makeSession(sessionID)

      expect(yield* fail({ action: "add", message: "m" }, sessionID)).toContain("schedule-spec-conflict")
      expect(yield* fail({ action: "add", message: "m", every: "30m", cron: "* * * * *" }, sessionID)).toContain(
        "schedule-spec-conflict",
      )
      expect(
        yield* fail({ action: "add", message: "m", every: "30m", at: "2030-01-01T00:00:00Z" }, sessionID),
      ).toContain("schedule-spec-conflict")
      expect(yield* fail({ action: "add", message: "m", every: "soon" }, sessionID)).toContain("invalid-interval")
      expect(yield* fail({ action: "add", message: "m", every: "0m" }, sessionID)).toContain("invalid-interval")
      expect(yield* fail({ action: "add", message: "m", cron: "61 * * * *" }, sessionID)).toContain("invalid-cron")
      expect(yield* fail({ action: "add", message: "m", cron: "a b c d e" }, sessionID)).toContain("invalid-cron")
      expect(yield* fail({ action: "add", message: "m", cron: "0 0 30 2 *" }, sessionID)).toContain(
        "cron-without-future-match",
      )
      expect(yield* fail({ action: "add", message: "m", at: "not-a-date" }, sessionID)).toContain("invalid-at")
      expect(
        yield* fail(
          { action: "add", every: "1h", message: "x".repeat(Scheduler.MAX_MESSAGE_LENGTH + 1) },
          sessionID,
        ),
      ).toContain("message-too-long")

      expect(yield* rowsFor(sessionID)).toEqual([])
    }),
  )

  it.instance("resolves zoned at values to their offset and rejects past values", () =>
    Effect.gen(function* () {
      yield* freshSchedules
      const sessionID = nextSession()
      yield* makeSession(sessionID)

      const now = yield* Clock.currentTimeMillis
      expect(
        yield* fail({ action: "add", message: "late", at: new Date(now - 1000).toISOString() }, sessionID),
      ).toContain("at-in-past")

      const result = yield* run({ action: "add", message: "zoned", at: "2030-01-01T09:00:00+03:00" }, sessionID)
      expect(result.output).toContain("2030-01-01T06:00:00Z")
      const rows = yield* rowsFor(sessionID)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.at).toBe(Date.UTC(2030, 0, 1, 6, 0, 0))
    }),
  )

  it.instance("stores a message at the exact length bound", () =>
    Effect.gen(function* () {
      yield* freshSchedules
      const sessionID = nextSession()
      yield* makeSession(sessionID)

      const exactly = "x".repeat(Scheduler.MAX_MESSAGE_LENGTH)
      yield* run({ action: "add", every: "1h", message: exactly }, sessionID)
      const rows = yield* rowsFor(sessionID)
      expect(rows[0]!.message).toHaveLength(Scheduler.MAX_MESSAGE_LENGTH)
    }),
  )

  it.instance("rejects the add at the per-session cap", () =>
    Effect.gen(function* () {
      yield* freshSchedules
      const sessionID = nextSession()
      yield* makeSession(sessionID)
      yield* seedSchedules(sessionID, Scheduler.MAX_SCHEDULES_PER_SESSION, 3_600_000)

      expect(yield* fail({ action: "add", every: "30m", message: "over cap" }, sessionID)).toContain(
        "schedule-cap-reached",
      )
      expect(yield* rowsFor(sessionID)).toHaveLength(Scheduler.MAX_SCHEDULES_PER_SESSION)
    }),
  )

  it.instance("asks the scheduler permission with the spec form on add and the id on remove", () =>
    Effect.gen(function* () {
      yield* freshSchedules
      asks.length = 0
      const sessionID = nextSession()
      yield* makeSession(sessionID)

      const added = yield* run({ action: "add", every: "30m", message: "asked" }, sessionID)
      expect(asks).toHaveLength(1)
      expect(asks[0]!.permission).toBe("scheduler")
      expect(asks[0]!.patterns).toEqual(["*/30 * * * *"])

      const id = added.output.match(/sch_[A-Za-z0-9]+/)![0]
      asks.length = 0
      yield* run({ action: "remove", id }, sessionID)
      expect(asks).toHaveLength(1)
      expect(asks[0]!.permission).toBe("scheduler")
      expect(asks[0]!.patterns).toEqual([id])
    }),
  )

  it.instance("a denied ask leaves state untouched", () =>
    Effect.gen(function* () {
      yield* freshSchedules
      asks.length = 0
      deny.denied = true
      const sessionID = nextSession()
      yield* makeSession(sessionID)
      const scheduler = yield* Scheduler.Service
      const added = yield* scheduler.add({ sessionID, message: "keep me", spec: { cron: "0 0 * * *" } })

      expect(yield* fail({ action: "add", every: "30m", message: "denied" }, sessionID)).toContain("permission-denied")
      expect(yield* fail({ action: "remove", id: added.id }, sessionID)).toContain("permission-denied")

      deny.denied = false
      expect(yield* rowsFor(sessionID)).toHaveLength(1)
      const result = yield* run({ action: "list" }, sessionID)
      expect(result.output).not.toContain("denied")
    }),
  )

  it.instance("list performs no permission ask", () =>
    Effect.gen(function* () {
      yield* freshSchedules
      asks.length = 0
      deny.denied = true
      const sessionID = nextSession()
      yield* makeSession(sessionID)

      const result = yield* run({ action: "list" }, sessionID)
      expect(result.metadata).toMatchObject({ action: "list" })
      expect(asks).toEqual([])
    }),
  )
})
