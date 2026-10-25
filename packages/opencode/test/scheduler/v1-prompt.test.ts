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
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
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
