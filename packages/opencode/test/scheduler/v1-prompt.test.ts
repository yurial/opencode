// Coverage for the real host binding of the scheduler's V1 prompt admission
// path (specs/scheduler.md I4, R6.5): a fire on a V1 session admits one
// synthetic user text part through SessionPrompt and starts the model turn.
// The delivery must complete with the admission — not with the turn — because
// the fired turn can call the scheduler tool, whose mutations serialize on
// the delivery loop's write permit (self-deadlock guard).

import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionV2 } from "@opencode-ai/core/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Scheduler } from "@opencode-ai/core/scheduler/scheduler"
import { ScheduleID } from "@opencode-ai/core/scheduler/schema"
import { ScheduleTable } from "@opencode-ai/core/scheduler/sql"
import { eq } from "drizzle-orm"
import { describe, expect, test } from "bun:test"
import { Cause, Context, Effect, Exit, Fiber, Layer, Scope } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { SchedulerV1Prompt } from "@opencode-ai/core/scheduler/v1-prompt"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Question } from "../../src/question"
import { SchedulerV1PromptLocal } from "../../src/scheduler/v1-prompt"
import { Session } from "@/session/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionID } from "../../src/session/schema"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "@/session/summary"
import { SystemPrompt } from "@/session/system"
import { Instruction } from "../../src/session/instruction"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { Todo } from "../../src/session/todo"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Format } from "../../src/format"
import { tmpdir } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in scheduler adapter tests"),
    authenticate: () => Effect.die("unexpected MCP auth in scheduler adapter tests"),
    finishAuth: () => Effect.succeed({ status: "disabled" as const }),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.die("unexpected MCP auth status in scheduler adapter tests"),
  }),
)

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  Agent.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  // The scheduler graph with the real host V1 admission binding. The
  // InstanceStore is a group member so the test body and the adapter share
  // one instance cache.
  SessionStore.node,
  InstanceStore.node,
  SessionV2.node,
  Scheduler.node,
  SchedulerV1PromptLocal.node,
  testLLMServerNode,
])

const replacements = [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  // The scheduler's execution dependency: the V1 delivery path never wakes
  // the V2 runtime, so a no-op execution keeps the graph honest about it.
  [SessionExecution.node, SessionExecution.noopLayer],
  [InstanceStore.bootstrapNode, InstanceBootstrap.node],
] as const

const it = testEffect(AppNodeBuilder.build(root, replacements))

// Config that registers a "test" provider with a "test-model" model so the
// fired turn resolves a model; baseURL is patched to the in-test LLM server.
function providerCfg(url: string) {
  return {
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: {
          apiKey: "test-key",
          baseURL: url,
        },
      },
    },
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const contextUpdatedType = EventV2.versionedType("session.next.context.updated", 1)

const clearSchedules = Database.Service.use(({ db }) => db.delete(ScheduleTable).run().pipe(Effect.orDie))

const scheduleRow = (id: ScheduleID) =>
  Database.Service.use(({ db }) =>
    db.select().from(ScheduleTable).where(eq(ScheduleTable.id, id)).get().pipe(Effect.orDie),
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

const assistantTexts = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const messages = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
    return messages
      .filter((message) => message.info.role === "assistant")
      .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
  })

describe("scheduler V1 prompt adapter", () => {
  it.live(
    "delivers a fire through the real adapter and returns before the model turn completes",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const dir = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ config: providerCfg(llm.url) })),
          (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.ignore),
        )
        yield* clearSchedules

        // The body and the adapter must share one InstanceStore: the adapter
        // resolves the session's directory through the same store.
        const instances = yield* InstanceStore.Service
        yield* instances.provide(
          { directory: dir.path },
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const scheduler = yield* Scheduler.Service
            const session = yield* sessions.create({ title: "scheduler v1 adapter" })

            // Hold the fired turn's model reply: the admission must not wait
            // for it (the fired turn can call the scheduler tool, whose
            // mutations need the delivery loop's write permit).
            const gate = defer<void>()
            yield* llm.hold("resumed by the scheduler", gate.promise)

            const added = yield* scheduler.add({
              sessionID: session.id,
              message: "fire me",
              name: "fire me",
              spec: { at: Date.now() + 200 },
            })

            // The delivery completes with the admission: the one-shot row is
            // removed while the model turn is still held by the gate.
            yield* pollWithTimeout(
              Effect.gen(function* () {
                const row = yield* scheduleRow(added.id)
                return row === undefined ? (true as const) : undefined
              }),
              "the scheduler fire never completed",
            )

            // The fired message reached the session as a synthetic user text
            // part through the real V1 prompt path.
            const messages = yield* sessions.messages({ sessionID: session.id }).pipe(Effect.orDie)
            const user = messages.find((message) => message.info.role === "user")
            expect(user).toBeDefined()
            const fired = user!.parts.find(
              (part): part is Extract<typeof part, { type: "text" }> =>
                part.type === "text" && part.synthetic === true && part.text.includes("fired schedule id"),
            )
            expect(fired).toBeDefined()
            expect(fired?.text.includes("fire me")).toBe(true)

            // The V1 route ran: no durable V2 ContextUpdated event exists.
            expect(yield* eventCount(contextUpdatedType)).toBe(0)

            // The held turn has not produced its reply yet.
            expect(yield* assistantTexts(session.id)).toEqual([])

            // Release the model turn; it completes in its own fiber.
            gate.resolve(undefined)
            yield* pollWithTimeout(
              Effect.gen(function* () {
                const texts = yield* assistantTexts(session.id)
                return texts.includes("resumed by the scheduler") ? (true as const) : undefined
              }),
              "the fired model turn never completed",
            )
          }),
        )
      }),
    30_000,
  )
})

// Runtime graph topology (specs/scheduler.md R8.1, R8.3): one process must
// hold exactly one scheduler/service with its single delivery loop, and the
// V1 prompt admission it fires into must be the one SessionPrompt/SessionRunState
// graph that owns the session's active runners. A host process that serves a
// session through two graphs (for example a listener plus AppRuntime) gets a
// second delivery loop — every fire is delivered twice — and a forked prompt
// loop that cannot see the active runner.

const hostGraphLayer = () => Layer.provideMerge(AppNodeBuilder.build(root, replacements), TestConsole.layer)

/** Runs a body against one host graph built through the process-shared memoMap. */
const runShared = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.scoped(body).pipe(Effect.exit)
    if (Exit.isFailure(exit)) {
      for (const error of Cause.prettyErrors(exit.cause)) yield* Effect.logError(error)
    }
    return yield* exit
  }).pipe(Effect.runPromise)

/** LLM hits excluding the forked title-generation request of a turn. */
const turnHits = (llm: TestLLMServer["Service"]) =>
  Effect.gen(function* () {
    const hits = yield* llm.hits
    return hits.filter((hit: { body: unknown }) => !JSON.stringify(hit.body).includes("Generate a title"))
  })

describe("scheduler runtime graph topology", () => {
  test(
    "two host graphs in one process share one scheduler runtime and deliver a fire exactly once",
    () =>
      runShared(
        Effect.gen(function* () {
          const scopeA = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(scopeA, Exit.void))
          const scopeB = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(scopeB, Exit.void))

          // Two independent compiles of the same nodes, built the way the
          // listener graph and the AppRuntime graph of one process are built:
          // through the process-shared memoMap (Server.startListener,
          // AppRuntime). The memoMap join is what keeps one instance set.
          const ctxA = yield* Layer.buildWithMemoMap(hostGraphLayer(), memoMap, scopeA)
          const ctxB = yield* Layer.buildWithMemoMap(hostGraphLayer(), memoMap, scopeB)

          expect(Context.get(ctxB, Scheduler.Service)).toBe(Context.get(ctxA, Scheduler.Service))
          expect(Context.get(ctxB, SessionPrompt.Service)).toBe(Context.get(ctxA, SessionPrompt.Service))
          expect(Context.get(ctxB, SessionRunState.Service)).toBe(Context.get(ctxA, SessionRunState.Service))
          expect(Context.get(ctxB, SchedulerV1Prompt.Service)).toBe(Context.get(ctxA, SchedulerV1Prompt.Service))

          const llm = Context.get(ctxA, TestLLMServer)
          const dir = yield* Effect.acquireRelease(
            Effect.promise(() => tmpdir({ config: providerCfg(llm.url) })),
            (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.ignore),
          )

          const instances = Context.get(ctxB, InstanceStore.Service)
          const sessions = Context.get(ctxB, Session.Service)
          const schedulerB = Context.get(ctxB, Scheduler.Service)
          yield* instances.provide(
            { directory: dir.path },
            Effect.gen(function* () {
              yield* clearSchedules
              const session = yield* sessions.create({ title: "graph topology" })

              // Schedule through graph A; the fire must be served by the one
              // joined scheduler, not once per graph.
              const added = yield* Context.get(ctxA, Scheduler.Service).add({
                sessionID: session.id,
                message: "fire me",
                name: "fire me",
                spec: { at: Date.now() + 200 },
              })
              yield* pollWithTimeout(
                Effect.gen(function* () {
                  const row = yield* scheduleRow(added.id)
                  return row === undefined ? (true as const) : undefined
                }),
                "the scheduler fire never completed",
              )

              // A second graph would deliver its own copy of the fire
              // moments later; give it the chance, then require exactly one.
              yield* Effect.sleep(500)
              const messages = yield* sessions.messages({ sessionID: session.id }).pipe(Effect.orDie)
              const fired = messages
                .filter((message) => message.info.role === "user")
                .flatMap((message) => message.parts)
                .filter(
                  (part): part is Extract<typeof part, { type: "text" }> =>
                    part.type === "text" && part.synthetic === true && part.text.includes("fired schedule id"),
                )
              expect(fired).toHaveLength(1)
              expect(fired[0]?.text.includes("fire me")).toBe(true)

              // The joined runtime serves the fire with a real model turn of
              // the one shared prompt path.
              yield* pollWithTimeout(
                Effect.gen(function* () {
                  return (yield* turnHits(llm)).length >= 1 ? (true as const) : undefined
                }),
                "the fired model turn never reached the LLM server",
              )
              expect(schedulerB).toBe(Context.get(ctxA, Scheduler.Service))

              // The process holds exactly one admission binding: the real
              // V1 prompt attached during the layer build, so a second attach
              // on the shared scheduler is refused (R8.1).
              const refused = yield* schedulerB.attachV1Prompt(
                SchedulerV1Prompt.Service.of({ prompt: () => Effect.void }),
              )
              expect(refused).toBe(false)
            }).pipe(Effect.provide(ctxB)),
          )
        }),
      ),
    30_000,
  )

  it.live(
    "a fire during an active V1 run joins the active runner and is served on the next loop iteration",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const dir = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ config: providerCfg(llm.url) })),
          (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.ignore),
        )
        yield* clearSchedules

        const instances = yield* InstanceStore.Service
        yield* instances.provide(
          { directory: dir.path },
          Effect.gen(function* () {
            const scheduler = yield* Scheduler.Service
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "scheduler fire joins active run" })

            // Hold the active turn's model reply: the session runner stays
            // busy while the gate holds.
            const gate = defer<void>()
            yield* llm.hold("first", gate.promise)
            const active = yield* prompt
              .prompt({ sessionID: session.id, parts: [{ type: "text", text: "start" }] })
              .pipe(Effect.forkChild)
            yield* llm.wait(1)

            // Fire while the run is active: the delivery completes with the
            // durable admission of the synthetic part.
            const added = yield* scheduler.add({
              sessionID: session.id,
              message: "fire me",
              name: "fire me",
              spec: { at: Date.now() + 100 },
            })
            yield* pollWithTimeout(
              Effect.gen(function* () {
                const row = yield* scheduleRow(added.id)
                return row === undefined ? (true as const) : undefined
              }),
              "the scheduler fire never completed",
            )
            const messages = yield* sessions.messages({ sessionID: session.id }).pipe(Effect.orDie)
            const admitted = messages
              .filter((message) => message.info.role === "user")
              .flatMap((message) => message.parts)
              .find(
                (part): part is Extract<typeof part, { type: "text" }> =>
                  part.type === "text" && part.synthetic === true && part.text.includes("fire me"),
              )
            expect(admitted).toBeDefined()

            // The forked loop joined the active runner: no second runLoop
            // started, so the only model request is the held one.
            expect(yield* turnHits(llm)).toHaveLength(1)
            yield* Effect.sleep(200)
            expect(yield* turnHits(llm)).toHaveLength(1)

            // Release the held turn; the joined loop continues on its next
            // iteration with the synthetic message as the newest user input.
            gate.resolve(undefined)
            yield* pollWithTimeout(
              Effect.gen(function* () {
                return (yield* turnHits(llm)).length >= 2 ? (true as const) : undefined
              }),
              "the joined loop never processed the fired message",
            )
            const turns = yield* turnHits(llm)
            const continued = JSON.stringify(turns.at(-1)?.body.messages)
            expect(continued).toContain("fire me")

            yield* pollWithTimeout(
              Effect.gen(function* () {
                const texts = yield* assistantTexts(session.id)
                return texts.includes("first") && texts.length >= 2 ? (true as const) : undefined
              }),
              "the fired message was never answered",
            )
            yield* Fiber.await(active)

            const settled = yield* sessions.messages({ sessionID: session.id }).pipe(Effect.orDie)
            const synthetics = settled
              .filter((message) => message.info.role === "user")
              .flatMap((message) => message.parts)
              .filter(
                (part): part is Extract<typeof part, { type: "text" }> =>
                  part.type === "text" && part.synthetic === true && part.text.includes("fired schedule id"),
              )
            expect(synthetics).toHaveLength(1)
          }),
        )
      }),
    30_000,
  )
})
