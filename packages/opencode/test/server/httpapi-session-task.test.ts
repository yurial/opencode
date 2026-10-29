import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { Database } from "@opencode-ai/core/database/database"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Scheduler } from "@opencode-ai/core/scheduler/scheduler"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionStore } from "@opencode-ai/core/session/store"
import { TaskRun } from "@opencode-ai/core/task-run/task-run"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
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
    // The test body seeds task_run rows directly; the rows are database
    // state, so the served graph's own TaskRun instance reads them.
    TaskRun.node,
  ]),
  [
    [InstanceStore.bootstrapNode, noopBootstrapLayer],
    // The workspace graph pulls in the scheduler, whose SessionExecution
    // dependency is unbound (same topology as the schedule-list test).
    [SessionExecution.node, SessionExecutionLocal.node],
  ],
)

// The task-run runner bound into the served graph: a stub with the same shape
// the task engine has — re-mark the row running and start the live job — so
// the endpoint, the test seeding, and the liveness reader all see one
// TaskRun instance and one live-job registry.
const stubRunnerNode = makeGlobalNode({
  service: TaskRun.Service,
  layer: Layer.effect(
    TaskRun.Service,
    Effect.gen(function* () {
      const registry = yield* TaskRun.Service
      const jobs = yield* BackgroundJob.Service
      yield* registry.attachLiveness({ get: (id) => jobs.get(id) })
      yield* registry.attachRunner({
        continue: (input) =>
          Effect.gen(function* () {
            yield* registry.markRunning(input.runID)
            yield* jobs.start({ id: input.runID, type: "task", run: Effect.never })
          }),
      })
      return registry
    }),
  ),
  deps: [TaskRun.node, BackgroundJob.node],
})

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.createRoutes(undefined, stubRunnerNode),
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

type TaskEntry = {
  id: string
  description: string
  state: string
  createdAt: number
  updatedAt: number
  settledAt: number | null
}

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

const taskPath = (sessionID: string) => `/api/session/${sessionID}/task`
const taskGetPath = (sessionID: string, taskID: string) => `/api/session/${sessionID}/task/${taskID}`
const taskContinuePath = (sessionID: string, taskID: string) => `/api/session/${sessionID}/task/${taskID}/continue`

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("session task HttpApi", () => {
  it.instance(
    "returns an empty task list for a session without runs",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Session.use.create({ title: "task empty" })
        const response = yield* request(taskPath(session.id), {
          headers: { "x-opencode-directory": test.directory },
        })
        expect(response.status).toBe(200)
        expect(yield* responseJson(response)).toEqual({ data: { tasks: [] } })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "lists every session run newest first with the derived state",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* Session.use.create({ title: "task order" })
        const registry = yield* TaskRun.Service

        const oldest = (yield* Session.use.create({ title: "run one" })).id
        const middle = (yield* Session.use.create({ title: "run two" })).id
        const newest = (yield* Session.use.create({ title: "run three" })).id
        yield* registry.launch({
          id: oldest,
          parentSession: session.id,
          childSession: oldest,
          description: "oldest run",
        })
        yield* registry.launch({
          id: middle,
          parentSession: session.id,
          childSession: middle,
          description: "middle run",
        })
        yield* registry.launch({
          id: newest,
          parentSession: session.id,
          childSession: newest,
          description: "newest run",
        })
        yield* registry.settle({ id: oldest, state: "completed" })

        const response = yield* request(taskPath(session.id), { headers })
        expect(response.status).toBe(200)
        const body = (yield* responseJson(response)) as { data: { tasks: TaskEntry[] } }
        // R5.5: one entry per run, newest launch first; R5.4/R4.11: a stored
        // running row with no live job reads interrupted on the surface.
        expect(body.data.tasks.map((entry) => entry.id)).toEqual([newest, middle, oldest])
        expect(body.data.tasks.map((entry) => entry.state)).toEqual(["interrupted", "interrupted", "completed"])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns exactly the entry fields with epoch millisecond times",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* Session.use.create({ title: "task fields" })
        const registry = yield* TaskRun.Service
        const run = (yield* Session.use.create({ title: "run fields" })).id
        yield* registry.launch({
          id: run,
          parentSession: session.id,
          childSession: run,
          description: "fix tests",
        })

        const response = yield* request(taskGetPath(session.id, run), { headers })
        expect(response.status).toBe(200)
        const body = (yield* responseJson(response)) as { data: TaskEntry }
        expect(body.data).toEqual({
          id: run,
          description: "fix tests",
          // A stored running row with no live job reads interrupted (R4.11).
          state: "interrupted",
          createdAt: body.data.createdAt,
          updatedAt: body.data.updatedAt,
          settledAt: null,
        })
        expect(Number.isInteger(body.data.createdAt)).toBe(true)
        expect(Number.isInteger(body.data.updatedAt)).toBe(true)
        // R5.6: every entry carries exactly id, description, state, createdAt,
        // updatedAt, and settledAt.
        expect(Object.keys(body.data).sort()).toEqual([
          "createdAt",
          "description",
          "id",
          "settledAt",
          "state",
          "updatedAt",
        ])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "reads without mutating runs or asking permission",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* Session.use.create({ title: "task read-only" })
        const registry = yield* TaskRun.Service
        const run = (yield* Session.use.create({ title: "run read-only" })).id
        yield* registry.launch({ id: run, parentSession: session.id, childSession: run, description: "one" })

        // R5.5, R5.6: the GETs are pure reads — no permission ask rides the
        // route and repeated reads agree.
        const first = yield* request(taskPath(session.id), { headers })
        const second = yield* request(taskPath(session.id), { headers })
        expect(yield* responseJson(second)).toEqual(yield* responseJson(first))
        expect(((yield* responseJson(first)) as { data: { tasks: TaskEntry[] } }).data.tasks).toHaveLength(1)

        const detail = yield* request(taskGetPath(session.id, run), { headers })
        expect(detail.status).toBe(200)
        expect(((yield* responseJson(detail)) as { data: TaskEntry }).data.state).toBe("interrupted")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "continues a run and returns the resulting running entry",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* Session.use.create({ title: "task continue" })
        const registry = yield* TaskRun.Service
        const run = (yield* Session.use.create({ title: "run continue" })).id
        yield* registry.launch({ id: run, parentSession: session.id, childSession: run, description: "fix tests" })
        yield* registry.settle({ id: run, state: "completed" })

        // The served graph binds the stub runner (same shape the task engine
        // has): re-mark running and start the live job before the prompt is
        // admitted.
        const response = yield* request(taskContinuePath(session.id, run), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ message: "extend the fix to the sister module" }),
        })
        expect(response.status).toBe(200)
        const body = (yield* responseJson(response)) as { data: TaskEntry }
        // R5.7: the response is the resulting running entry — a live job
        // reads running from the live-job registry.
        expect(body.data.id).toBe(run)
        expect(body.data.state).toBe("running")
        expect(body.data.settledAt).toBeNull()
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "fails with TaskNotFoundError for unknown and foreign task ids",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* Session.use.create({ title: "task missing" })
        const registry = yield* TaskRun.Service
        const foreign = (yield* Session.use.create({ title: "foreign run" })).id
        const other = yield* Session.use.create({ title: "other parent" })
        yield* registry.launch({
          id: foreign,
          parentSession: other.id,
          childSession: foreign,
          description: "foreign",
        })

        const missing = yield* request(taskGetPath(session.id, "ses_missing"), { headers })
        expect(missing.status).toBe(404)
        expect(yield* responseJson(missing)).toEqual({
          _tag: "TaskNotFoundError",
          sessionID: session.id,
          taskID: "ses_missing",
          message: expect.any(String),
        })

        const foreignGet = yield* request(taskGetPath(session.id, foreign), { headers })
        expect(foreignGet.status).toBe(404)
        expect(((yield* responseJson(foreignGet)) as { _tag: string })._tag).toBe("TaskNotFoundError")

        const foreignContinue = yield* request(taskContinuePath(session.id, foreign), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ message: "hello" }),
        })
        expect(foreignContinue.status).toBe(404)
        expect(((yield* responseJson(foreignContinue)) as { _tag: string })._tag).toBe("TaskNotFoundError")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "fails with SessionNotFoundError for an unknown session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const missing = SessionID.descending()
        const response = yield* request(taskPath(missing), {
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
    "fails with InvalidRequestError for an undecodable session or task id",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* Session.use.create({ title: "task decode" })

        const badSession = yield* request(taskPath("not-a-session"), { headers })
        expect(badSession.status).toBe(400)
        expect(yield* responseJson(badSession)).toMatchObject({ _tag: "InvalidRequestError" })

        const badTask = yield* request(taskGetPath(session.id, "not-a-task"), { headers })
        expect(badTask.status).toBe(400)
        expect(yield* responseJson(badTask)).toMatchObject({ _tag: "InvalidRequestError" })

        const badContinue = yield* request(taskContinuePath(session.id, "not-a-task"), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ message: "hello" }),
        })
        expect(badContinue.status).toBe(400)
        expect(yield* responseJson(badContinue)).toMatchObject({ _tag: "InvalidRequestError" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
