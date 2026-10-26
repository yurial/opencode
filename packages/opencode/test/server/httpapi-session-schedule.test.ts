import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Scheduler } from "@opencode-ai/core/scheduler/scheduler"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionStore } from "@opencode-ai/core/session/store"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Workspace } from "../../src/control-plane/workspace"
import { Session } from "@/session/session"
import { SessionID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([
    InstanceStore.node,
    Project.node,
    Session.node,
    Workspace.node,
    Database.node,
    SessionStore.node,
    Ripgrep.node,
    // The schedule-list handler and the test setup both read and add through
    // the scheduler service; SessionExecution below must be bound for it.
    Scheduler.node,
  ]),
  [
    [InstanceStore.bootstrapNode, noopBootstrapLayer],
    // The workspace graph pulls in the scheduler, whose SessionExecution
    // dependency is unbound; bind a real local execution so the merge does
    // not hand the served routes a no-op wake.
    [SessionExecution.node, SessionExecutionLocal.node],
  ],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

type ScheduleEntry = {
  id: string
  spec: { cron: string } | { at: number }
  message: string
  nextFireAt: number
}

const DAY = 24 * 60 * 60 * 1000

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function responseJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json
}

const schedulePath = (sessionID: string) => `/api/session/${sessionID}/schedule`

const listSchedules = (sessionID: string, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const response = yield* request(schedulePath(sessionID), { headers })
    expect(response.status).toBe(200)
    return (yield* responseJson(response)) as { data: { schedules: ScheduleEntry[] } }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("session schedule HttpApi", () => {
  it.instance(
    "returns an empty schedule list for a session without schedules",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Session.use.create({ title: "schedule empty" })
        const body = yield* listSchedules(session.id, { "x-opencode-directory": test.directory })
        expect(body).toEqual({ data: { schedules: [] } })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "lists every session schedule ordered by next fire time then id",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* Session.use.create({ title: "schedule order" })
        const scheduler = yield* Scheduler.Service
        const now = Date.now()
        // Add out of order on purpose: the response must re-order by
        // nextFireAt (R3.3), not by insertion or stored id order.
        const latest = yield* scheduler.add({
          sessionID: session.id,
          message: "latest",
          spec: { at: now + 3 * DAY },
        })
        const earliest = yield* scheduler.add({
          sessionID: session.id,
          message: "earliest",
          spec: { at: now + 1 * DAY },
        })
        const middle = yield* scheduler.add({
          sessionID: session.id,
          message: "middle",
          spec: { at: now + 2 * DAY },
        })
        // Two entries sharing one instant order by id ascending; ids minted
        // from the ascending generator keep insertion order under the tiebreak.
        const tieFirst = yield* scheduler.add({
          sessionID: session.id,
          message: "tie first",
          spec: { at: now + 5 * DAY },
        })
        const tieSecond = yield* scheduler.add({
          sessionID: session.id,
          message: "tie second",
          spec: { at: now + 5 * DAY },
        })

        const body = yield* listSchedules(session.id, headers)
        expect(body.data.schedules.map((entry) => entry.id)).toEqual([
          earliest.id,
          middle.id,
          latest.id,
          tieFirst.id,
          tieSecond.id,
        ])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns exactly the entry fields with epoch millisecond times",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* Session.use.create({ title: "schedule fields" })
        const scheduler = yield* Scheduler.Service
        const due = Date.now() + 6 * 60 * 60 * 1000

        const oneShot = yield* scheduler.add({ sessionID: session.id, message: "deploy check", spec: { at: due } })
        const recurring = yield* scheduler.add({
          sessionID: session.id,
          message: "daily digest",
          spec: { cron: "0 0 * * *" },
        })

        const body = yield* listSchedules(session.id, headers)
        expect(body.data.schedules).toHaveLength(2)
        // R3.3 orders entries by nextFireAt ascending, and the relative order
        // of now+6h and the daily cron midnight flips at 18:00 UTC — locate
        // the entries by id; the ordering itself is covered by the ordering
        // test above.
        const oneShotEntry = body.data.schedules.find((entry) => entry.id === oneShot.id)!
        expect(oneShotEntry).toEqual({
          id: oneShot.id,
          spec: { at: due },
          message: "deploy check",
          nextFireAt: due,
        })
        expect(oneShotEntry.id).toMatch(/^sch_/)
        expect(Object.keys(oneShotEntry).sort()).toEqual(["id", "message", "nextFireAt", "spec"])

        const cronEntry = body.data.schedules.find((entry) => entry.id === recurring.id)!
        expect(cronEntry).toEqual({
          id: recurring.id,
          spec: { cron: "0 0 * * *" },
          message: "daily digest",
          nextFireAt: cronEntry.nextFireAt,
        })
        // R3.4: the stored next-due-time as integer UTC epoch milliseconds —
        // the cron schedule's first midnight match lies in the future.
        expect(Number.isInteger(cronEntry.nextFireAt)).toBe(true)
        expect(cronEntry.nextFireAt).toBeGreaterThan(Date.now())
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "reads without mutating schedules or asking permission",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* Session.use.create({ title: "schedule read-only" })
        const scheduler = yield* Scheduler.Service
        const now = Date.now()
        yield* scheduler.add({ sessionID: session.id, message: "one", spec: { at: now + 1 * DAY } })
        yield* scheduler.add({ sessionID: session.id, message: "two", spec: { at: now + 2 * DAY } })

        // R3.5: the GET is a pure read — no permission ask rides the route
        // (the request succeeds with no ask wiring) and repeated reads agree.
        const first = yield* listSchedules(session.id, headers)
        const second = yield* listSchedules(session.id, headers)
        expect(second).toEqual(first)
        expect(first.data.schedules).toHaveLength(2)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "fails with SessionNotFoundError for an unknown session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const missing = SessionID.descending()
        const response = yield* request(schedulePath(missing), {
          headers: { "x-opencode-directory": test.directory },
        })
        expect(response.status).toBe(404)
        expect(yield* responseJson(response)).toEqual({
          _tag: "SessionNotFoundError",
          sessionID: missing,
          message: `Session not found: ${missing}`,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "fails with InvalidRequestError for an undecodable session id",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const response = yield* request(schedulePath("not-a-session"), {
          headers: { "x-opencode-directory": test.directory },
        })
        expect(response.status).toBe(400)
        expect(yield* responseJson(response)).toMatchObject({ _tag: "InvalidRequestError" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
