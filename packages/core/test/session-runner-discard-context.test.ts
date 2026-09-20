import { describe, expect, test } from "bun:test"
import { Model, LLMClient, LLMEvent, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment, Prompt } from "@opencode-ai/core/session/prompt"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { DiscardContext } from "@opencode-ai/core/session/runner/discard-context"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { DiscardContextTool } from "@opencode-ai/core/tool/discard-context"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Location } from "@opencode-ai/core/location"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionStore } from "@opencode-ai/core/session/store"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const created = DateTime.makeUnsafe(0)
const translationModel = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })

const entry = (seq: number, message: SessionMessage.Message) => ({ seq, message })
const messages = (entries: readonly DiscardContext.Entry[]) => entries.map((item) => item.message)

const user = (id: string, text: string): SessionMessage.User =>
  SessionMessage.User.make({ id: SessionMessage.ID.make(`msg_${id}`), type: "user", text, time: { created } })

const assistant = (id: string, content: SessionMessage.AssistantContent[]): SessionMessage.Assistant =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(`msg_${id}`),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content,
    time: { created, completed: created },
  })

const textPart = (id: string, text: string) => SessionMessage.AssistantText.make({ type: "text", id, text })

const reasoningPart = (id: string, text: string) =>
  SessionMessage.AssistantReasoning.make({ type: "reasoning", id, text })

const settledToolPart = (id: string, name: string, input: Record<string, unknown>) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id,
    name,
    state: SessionMessage.ToolStateCompleted.make({ status: "completed", input, content: [], structured: {} }),
    time: { created, completed: created },
  })

const discardCall = (ids: readonly string[]) => settledToolPart("call-discard", DiscardContextTool.name, { ids })

describe("DiscardContext.filterEntries", () => {
  test("removes marked parts, hides discard calls, and preserves order", () => {
    const filtered = DiscardContext.filterEntries([
      entry(1, user("user-1", "Start")),
      entry(2, assistant("assistant-1", [textPart("text-1", "A"), reasoningPart("reasoning-1", "R"), textPart("text-2", "B")])),
      entry(3, assistant("assistant-2", [discardCall(["reasoning-1", "missing-id"])])),
      entry(4, user("user-2", "End")),
    ])

    expect(messages(filtered)).toEqual([
      user("user-1", "Start"),
      assistant("assistant-1", [textPart("text-1", "A"), textPart("text-2", "B")]),
      user("user-2", "End"),
    ])
  })

  test("drops assistant messages that become empty after filtering", () => {
    const filtered = DiscardContext.filterEntries([
      entry(1, user("user-1", "Start")),
      entry(2, assistant("assistant-1", [textPart("text-1", "Only")])),
      entry(3, assistant("assistant-2", [discardCall(["text-1"])])),
    ])

    expect(messages(filtered)).toEqual([user("user-1", "Start")])
  })

  test("removes a marked tool call together with its result pair", () => {
    const filtered = DiscardContext.filterEntries([
      entry(1, user("user-1", "Start")),
      entry(2, assistant("assistant-1", [settledToolPart("call-read", "read", { path: "README.md" })])),
      entry(3, assistant("assistant-2", [discardCall(["call-read"])])),
    ])

    // The discard call's own message becomes empty and is dropped with the pair.
    expect(messages(filtered)).toEqual([user("user-1", "Start")])
    expect(JSON.stringify(toLLMMessages(messages(filtered), translationModel))).not.toContain("call-read")
    expect(JSON.stringify(toLLMMessages(messages(filtered), translationModel))).not.toContain("README.md")
  })

  test("ignores unknown ids and keeps messages without addressable parts", () => {
    const filtered = DiscardContext.filterEntries([
      entry(1, user("user-1", "Start")),
      entry(2, assistant("assistant-1", [discardCall(["missing-1", "missing-2"]), textPart("text-1", "Stay")])),
      entry(3, user("user-2", "user text is never addressable")),
    ])

    expect(messages(filtered)).toEqual([
      user("user-1", "Start"),
      assistant("assistant-1", [textPart("text-1", "Stay")]),
      user("user-2", "user text is never addressable"),
    ])
  })

  test("returns entries unchanged when history has no discard calls", () => {
    const entries = [
      entry(1, user("user-1", "Start")),
      entry(2, assistant("assistant-1", [textPart("text-1", "A")])),
    ]

    expect(DiscardContext.filterEntries(entries)).toEqual(entries)
  })

  test("reads ids from pending tool input JSON and ignores broken input", () => {
    const pending = (input: string) =>
      SessionMessage.AssistantTool.make({
        type: "tool",
        id: "call-discard",
        name: DiscardContextTool.name,
        state: SessionMessage.ToolStatePending.make({ status: "pending", input }),
        time: { created },
      })

    const parsed = DiscardContext.filterEntries([
      entry(1, user("user-1", "Start")),
      entry(2, assistant("assistant-1", [textPart("text-1", "Marked"), textPart("text-2", "Stay")])),
      entry(3, assistant("assistant-2", [pending(JSON.stringify({ ids: ["text-1", 42] }))])),
    ])
    expect(messages(parsed)).toEqual([
      user("user-1", "Start"),
      assistant("assistant-1", [textPart("text-2", "Stay")]),
    ])

    const unparsed = DiscardContext.filterEntries([
      entry(1, user("user-1", "Start")),
      entry(2, assistant("assistant-1", [textPart("text-1", "Stay")])),
      entry(3, assistant("assistant-2", [pending("{not json")])),
    ])
    expect(messages(unparsed)).toEqual([
      user("user-1", "Start"),
      assistant("assistant-1", [textPart("text-1", "Stay")]),
    ])
  })

  test("removes a marked user text part, keeps the message when files remain, and drops emptied user messages (T2.7)", () => {
    const withFile = SessionMessage.User.make({
      id: SessionMessage.ID.make("msg_user-files"),
      type: "user",
      text: "Look at this",
      files: [FileAttachment.create({ uri: "file:///tmp/a.png", mime: "image/png" })],
      time: { created },
    })
    const filtered = DiscardContext.filterEntries([
      entry(1, user("user-1", "Start")),
      entry(2, assistant("assistant-1", [textPart("text-1", "A")])),
      entry(3, assistant("assistant-2", [discardCall(["text-1", "msg_user-files", "msg_user-temp"])])),
      entry(4, withFile),
      entry(5, user("user-temp", "Temp")),
      entry(6, user("user-2", "End")),
    ])

    expect(messages(filtered)).toEqual([
      user("user-1", "Start"),
      { ...withFile, text: "" },
      user("user-2", "End"),
    ])
    // The emptied user text part never reaches the projection; the file part
    // and the message remain (A4.2).
    const lowered = toLLMMessages(messages(filtered), translationModel)
    expect(JSON.stringify(lowered)).not.toContain("Look at this")
    expect(JSON.stringify(lowered)).toContain("a.png")
  })

  test("ignores marked ids naming parts of the most recent user entry (T2.8)", () => {
    const filtered = DiscardContext.filterEntries([
      entry(1, user("user-1", "Keep")),
      entry(2, assistant("assistant-1", [discardCall(["msg_user-2"])])),
      entry(3, user("user-2", "Current")),
    ])

    expect(messages(filtered)).toEqual([user("user-1", "Keep"), user("user-2", "Current")])
  })

  test("matches user parts only by their own id, never by a tool call id (T2.9)", () => {
    const filtered = DiscardContext.filterEntries([
      entry(1, user("user-1", "Mine")),
      entry(2, assistant("assistant-1", [settledToolPart("call-reader", "read", { path: "README.md" })])),
      entry(3, assistant("assistant-2", [discardCall(["call-reader"])])),
      entry(4, user("user-2", "End")),
    ])

    // The tool part goes via its call id; the user entries are untouched.
    expect(messages(filtered)).toEqual([user("user-1", "Mine"), user("user-2", "End")])
  })

  test("keeps working without user entries; the most-recent-user guard is inert (R4.8)", () => {
    const filtered = DiscardContext.filterEntries([
      entry(1, assistant("assistant-1", [textPart("text-1", "Stay")])),
      entry(2, assistant("assistant-2", [discardCall(["missing-1"])])),
    ])

    expect(messages(filtered)).toEqual([assistant("assistant-1", [textPart("text-1", "Stay")])])
  })

  test("keeps a marked user message that was already empty instead of dropping it (mirror, m5)", () => {
    const empty = SessionMessage.User.make({
      id: SessionMessage.ID.make("msg_user-empty"),
      type: "user",
      text: "",
      time: { created },
    })
    const filtered = DiscardContext.filterEntries([
      entry(1, empty),
      entry(2, assistant("assistant-1", [discardCall(["msg_user-empty"])])),
      entry(3, user("user-2", "Current")),
    ])

    // Filtering only drops what it empties; a message with no removable
    // content stays, mirroring the V1 filter. The discard call itself hides.
    expect(messages(filtered)).toEqual([empty, user("user-2", "Current")])
  })

  test("merges same-role neighbors stranded by filtering (R4.10)", () => {
    // The runner lowers flag-on turns with both projection options; the merge
    // must not apply to unfiltered turns.
    const lower = (msgs: readonly SessionMessage.Message[]) =>
      toLLMMessages(msgs, translationModel, { partIdMarkers: true, mergeSameRole: true })

    // Two users stranded by the assistant emptied in between.
    const strandedUsers = DiscardContext.filterEntries([
      entry(1, user("user-1", "One")),
      entry(2, assistant("assistant-1", [textPart("text-a", "A")])),
      entry(3, assistant("assistant-2", [discardCall(["text-a"])])),
      entry(4, user("user-2", "Two")),
    ])
    const loweredUsers = lower(messages(strandedUsers))
    expect(loweredUsers.map((message) => message.role)).toEqual(["user"])
    const texts = loweredUsers[0]!.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
    expect(texts.join("\n")).toContain("One")
    expect(texts.join("\n")).toContain("Two")

    // Two assistants stranded by the discard call dropped in between.
    const strandedAssistants = DiscardContext.filterEntries([
      entry(1, user("user-1", "Start")),
      entry(2, assistant("assistant-1", [textPart("text-a", "A")])),
      entry(3, assistant("assistant-2", [textPart("text-b", "B")])),
      entry(4, assistant("assistant-3", [discardCall(["missing"])])),
      entry(5, user("user-2", "End")),
    ])
    const loweredAssistants = lower(messages(strandedAssistants))
    expect(loweredAssistants.map((message) => message.role)).toEqual(["user", "assistant", "user"])
    const body = JSON.stringify(loweredAssistants)
    expect(body).toContain("A")
    expect(body).toContain("B")

    // Unfiltered turns keep the unmerged shape.
    const unfiltered = toLLMMessages(
      [user("user-1", "One"), user("user-2", "Two")],
      translationModel,
    )
    expect(unfiltered.map((message) => message.role)).toEqual(["user", "user"])
  })
})

const sessionID = SessionV2.ID.make("ses_discard_runner_test")

const requests: LLMRequest[] = []
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let currentModel = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const compactModel = Model.make({
  id: "compact",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 4_000, output: 50 } }),
})

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      return Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const models = SessionRunnerModel.layerWith(() => Effect.succeed(currentModel))
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: SystemContext.Key.make("test/context"),
        load: Effect.sync(() =>
          SystemContext.combine([
            SystemContext.make({
              key: SystemContext.Key.make("test/context"),
              codec: Schema.toCodecJson(Schema.String),
              load: Effect.succeed("Initial context"),
              baseline: String,
              update: (_previous, current) => current,
              removed: () => "System context source removed: test/context",
            }),
          ]),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
// Each harness compiles an independent layer graph with a fixed config: the
// tool registration gate reads config when the graph is built (before a test
// body runs), so the flag is fixed per harness while per-turn reads inside the
// runner stay runtime. Compaction settings are identical in both variants so
// construction-time compaction config does not depend on the flag.
const compactionConfig = {
  compaction: new ConfigCompaction.Info({
    buffer: 3_000,
    keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
  }),
}
const harness = (discardContext: boolean) => {
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({ ...compactionConfig, discard_context: discardContext }),
          }),
        ]),
    }),
  )
  const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
    [Snapshot.node, Snapshot.noopLayer],
    [LayerNodePlatform.llmClient, client],
    [SessionRunnerModel.node, models],
    [SystemContextRegistry.node, systemContext],
    [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
    [SkillGuidance.node, skillGuidance],
    [ReferenceGuidance.node, referenceGuidance],
    [PermissionV2.node, permission],
    [Config.node, config],
  ])
  const execution = Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const sessionRunner = yield* SessionRunner.Service
      const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
        drain: (id, force) => sessionRunner.run({ sessionID: id, force }),
      })
      return SessionExecution.Service.of({
        active: coordinator.active,
        resume: coordinator.run,
        wake: coordinator.wake,
        interrupt: coordinator.interrupt,
      })
    }),
  ).pipe(Layer.provide(runnerLayer))
  return testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        EventV2.node,
        QuestionV2.node,
        SessionProjector.node,
        SessionStore.node,
        ApplicationTools.node,
        AgentV2.node,
        ToolRegistry.node,
        ToolRegistry.toolsNode,
        DiscardContextTool.node,
        SessionRunnerModel.node,
        SystemContextRegistry.node,
        SkillGuidance.node,
        ReferenceGuidance.node,
        Config.node,
        Snapshot.node,
        SessionRunnerLLM.node,
        SessionExecution.node,
        SessionV2.node,
      ]),
      [
        [LayerNodePlatform.llmClient, client],
        [PermissionV2.node, permission],
        [SessionRunnerModel.node, models],
        [SystemContextRegistry.node, systemContext],
        [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
        [SkillGuidance.node, skillGuidance],
        [ReferenceGuidance.node, referenceGuidance],
        [Snapshot.node, Snapshot.noopLayer],
        [SessionExecution.node, execution],
        [Config.node, config],
      ],
    ),
  )
}

const itEnabled = harness(true)
const itPlain = harness(false)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  response = []
  responses = undefined
  requests.length = 0
  currentModel = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
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
      slug: sessionID,
      directory: "/project",
      title: "discard",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const textTurn = (id: string, text: string): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const discardTurn = (ids: readonly string[]): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: "call-discard", name: DiscardContextTool.name, input: { ids } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const userTexts = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
  )

const systemTexts = (request: LLMRequest) => request.system.map((part) => part.text)

const durableRow = (message: SessionMessage.Message, seq: number) => {
  const { id, type, ...data } = Schema.encodeSync(SessionMessage.Message)(message)
  return { id: SessionMessage.ID.make(id), session_id: sessionID, type, seq, data }
}

describe("SessionRunner discard_context", () => {
  itEnabled.effect("appends the discard instruction to system when the flag is enabled", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = textTurn("text-hello", "Hello")
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Hi" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(systemTexts(requests[0]!)).toContain(DiscardContext.INSTRUCTION)
    }),
  )

  itPlain.effect("keeps the instruction out of system when the flag is disabled", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = textTurn("text-hello", "Hello")
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Hi" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(systemTexts(requests[0]!)).not.toContain(DiscardContext.INSTRUCTION)
    }),
  )

  itEnabled.effect("hides marked parts and discard calls from later provider turns and survives resume", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start" }), resume: false })
      response = textTurn("text-plan", "OLD PLAN")
      yield* session.resume(sessionID)

      requests.length = 0
      responses = [discardTurn(["text-plan"]), textTurn("text-done", "Done")]
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      // The request of the discard turn still shows the plan part.
      expect(JSON.stringify(requests[0])).toContain("OLD PLAN")
      // The continuation request reloads history from the database and filters it.
      expect(JSON.stringify(requests[1])).not.toContain("OLD PLAN")
      expect(JSON.stringify(requests[1])).not.toContain("call-discard")
      expect(requests[1]!.messages.map((message) => message.role)).toEqual(["user"])
      // Session history keeps every message, including the marked part.
      const context = yield* session.context(sessionID)
      expect(context.map((message) => message.type)).toEqual(["user", "assistant", "assistant", "assistant"])
      expect(context[1]).toMatchObject({ content: [{ type: "text", id: "text-plan", text: "OLD PLAN" }] })
      expect(context[2]).toMatchObject({
        content: [{ type: "tool", id: "call-discard", state: { status: "completed", input: { ids: ["text-plan"] } } }],
      })
    }),
  )

  itEnabled.effect("compacts from filtered entries so marked parts never reach the summary", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start" }), resume: false })
      response = textTurn("text-old", `DISCARD_ME_TOKEN ${"d".repeat(8_000)}`)
      yield* session.resume(sessionID)

      responses = [discardTurn(["text-old"]), textTurn("text-keep", `KEEP_SUMMARY_MARKER ${"k".repeat(11_000)}`)]
      yield* session.resume(sessionID)

      currentModel = compactModel
      requests.length = 0
      responses = [
        textTurn("text-summary", "## Objective\n- Preserve the task"),
        textTurn("text-final", "Continued"),
      ]
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const summary = userTexts(requests[0]!).join("\n")
      expect(summary).toContain("## Objective")
      expect(summary).toContain("KEEP_SUMMARY_MARKER")
      expect(summary).not.toContain("DISCARD_ME_TOKEN")
      const continuation = userTexts(requests[1]!).join("\n")
      expect(continuation).toContain("<conversation-checkpoint>")
      expect(continuation).not.toContain("DISCARD_ME_TOKEN")
      // History still holds the marked content.
      const { db } = yield* Database.Service
      const rows = yield* db
        .select({ data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(JSON.stringify(rows)).toContain("DISCARD_ME_TOKEN")
      const context = yield* session.context(sessionID)
      expect(context.some((message) => message.type === "compaction")).toBe(true)
    }),
  )

  itEnabled.effect("filters parts loaded fresh from the database across a restart", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionMessageTable)
        .values([
          durableRow(user("user-1", "Start"), 1),
          durableRow(assistant("assistant-1", [textPart("text-old", "OLD PLAN")]), 2),
          durableRow(assistant("assistant-2", [discardCall(["text-old"])]), 3),
        ])
        .run()
        .pipe(Effect.orDie)

      const filtered = DiscardContext.filterEntries(yield* SessionHistory.entriesForRunner(db, sessionID, 0))

      expect(filtered).toHaveLength(1)
      expect(filtered[0]).toMatchObject({ seq: 1, message: { type: "user", text: "Start" } })
      expect(JSON.stringify(filtered)).not.toContain("OLD PLAN")
    }),
  )

  itEnabled.effect("keeps the lowered request valid when filtering drops emptied user messages (T3.6)", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionMessageTable)
        .values([
          durableRow(user("user-1", "Start"), 1),
          durableRow(
            assistant("assistant-1", [textPart("text-a", "A"), settledToolPart("call-read", "read", { path: "r" })]),
            2,
          ),
          durableRow(assistant("assistant-2", [discardCall(["text-a", "msg_user-2", "msg_user-3"])]), 3),
          durableRow(user("user-2", "Temp"), 4),
          durableRow(user("user-3", "Current"), 5),
        ])
        .run()
        .pipe(Effect.orDie)

      const filtered = DiscardContext.filterEntries(yield* SessionHistory.entriesForRunner(db, sessionID, 0))
      const lowered = toLLMMessages(
        filtered.map((item) => item.message),
        translationModel,
      )

      // user-1 stays, assistant-1 keeps its tool call, user-2 is emptied and
      // dropped, the discard call disappears, user-3 (the most recent user
      // entry) survives whole even though its id was marked.
      expect(lowered.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"])
      expect(JSON.stringify(lowered)).not.toContain("Temp")
      expect(JSON.stringify(lowered)).toContain("Current")
      expect(JSON.stringify(lowered)).not.toContain("[part id:")
    }),
  )

  itEnabled.effect("projects text parts with the marker line and tool parts by their call ids (T3.7)", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = textTurn("text-plan", "OLD PLAN")
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Hi" }), resume: false })
      yield* session.resume(sessionID)

      // A later turn carries both messages: the user text part projects under
      // the message id, the assistant text part under its part id.
      requests.length = 0
      responses = [textTurn("text-other", "STAY")]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(1)
      const body = JSON.stringify(requests[0]!)
      expect(body).toMatch(/\[part id: msg_[0-9A-Za-z]+\]/)
      expect(body).toContain("[part id: text-plan]")

      // Tool parts project their provider call id natively, with no marker
      // line, whether or not the flag is enabled (R8.3).
      const lowered = toLLMMessages([assistant("assistant-x", [settledToolPart("call-read", "read", { path: "r" })])], translationModel, {
        partIdMarkers: true,
      })
      expect(JSON.stringify(lowered)).toContain("call-read")
      expect(JSON.stringify(lowered)).not.toContain("[part id: call-")
    }),
  )

  itPlain.effect("projects no marker line when the flag is disabled (T3.8)", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = textTurn("text-plan", "OLD PLAN")
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Hi" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(JSON.stringify(requests[0])).not.toContain("[part id:")
    }),
  )

  itEnabled.effect("keeps the projected-id-marker out of durable rows and session reads (T3.9)", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = textTurn("text-plan", "OLD PLAN")
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Hi" }), resume: false })
      yield* session.resume(sessionID)

      const { db } = yield* Database.Service
      const rows = yield* db
        .select({ data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(JSON.stringify(rows)).not.toContain("[part id:")
      const context = yield* session.context(sessionID)
      expect(JSON.stringify(context)).not.toContain("[part id:")
      expect(JSON.stringify(context)).toContain("OLD PLAN")
    }),
  )
})
