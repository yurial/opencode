import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment } from "@opencode-ai/core/session/prompt"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { DiscardContextTool } from "@opencode-ai/core/tool/discard-context"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

// Each harness compiles an independent layer so the construction-time
// registration gate sees a fixed config regardless of test order. The tool
// reads the loaded session history to count matched ids, so the graph carries
// the store and its database.
const harness = (discardContext: boolean) =>
  testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        ToolRegistry.node,
        ToolRegistry.toolsNode,
        DiscardContextTool.node,
        SessionStore.node,
        Database.node,
      ]),
      [
        [
          Config.node,
          Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () =>
                Effect.succeed([
                  new Config.Document({
                    type: "document",
                    info: new Config.Info({ discard_context: discardContext }),
                  }),
                ]),
            }),
          ),
        ],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ],
    ),
  )

const itEnabled = harness(true)
const itDisabled = harness(false)

const sessionID = SessionV2.ID.make("ses_discard_tool_test")

const call = (input: unknown, id = "call-discard") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: DiscardContextTool.name, input },
})

const created = DateTime.makeUnsafe(0)
// Durable history the matched-count reads: an assistant text part, a settled
// read call, and a user message carrying an id-bearing attachment — all
// addressable.
const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
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
      title: "discard-tool",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const rows = [
    SessionMessage.Assistant.make({
      id: SessionMessage.ID.make("msg_seed"),
      type: "assistant",
      agent: "build",
      model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
      content: [
        SessionMessage.AssistantText.make({ type: "text", id: "text-seed", text: "seeded text" }),
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call-read",
          name: "read",
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: {},
            content: [],
            structured: {},
          }),
          time: { created, completed: created },
        }),
      ],
      time: { created, completed: created },
    }),
    SessionMessage.User.make({
      id: SessionMessage.ID.make("msg_seed_user"),
      type: "user",
      text: "with attachment",
      files: [FileAttachment.create({ id: "file-seed", uri: "file:///tmp/seed.txt", mime: "text/plain" })],
      time: { created },
    }),
  ]
  const values = rows.map((message, seq) => {
    const { id, type, ...data } = Schema.encodeSync(SessionMessage.Message)(message)
    return { id: SessionMessage.ID.make(id), session_id: sessionID, type, seq: seq + 1, data }
  })
  yield* db.insert(SessionMessageTable).values(values).onConflictDoNothing().run().pipe(Effect.orDie)
})

describe("DiscardContextTool", () => {
  itDisabled.effect("does not register when discard_context is disabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([])
    }),
  )

  itEnabled.effect("registers when enabled, echoes the ids, and reports the matched count (T1.2, T1.8)", () =>
    Effect.gen(function* () {
      yield* seed
      const registry = yield* ToolRegistry.Service
      const ids = ["text-seed", "call-read", "missing-id"]

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([DiscardContextTool.name])
      const settled = yield* settleTool(registry, call({ ids }))
      expect(settled.result).toMatchObject({ type: "text", value: DiscardContextTool.successLine(2) })
      expect(settled.output).toMatchObject({
        structured: { ids },
        content: [{ type: "text", text: DiscardContextTool.successLine(2) }],
      })
    }),
  )

  itEnabled.effect("rejects invalid input", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      for (const input of [{}, { ids: "text-seed" }, { ids: ["text-seed", 42] }]) {
        expect(yield* executeTool(registry, call(input))).toMatchObject({
          type: "error",
          value: expect.stringContaining("Invalid tool input"),
        })
      }
    }),
  )

  itEnabled.effect("zero-count settled output is a non-empty line that forbids a blind repeat (T1.7)", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      for (const input of [{ ids: [] }, { ids: ["ghost-1", "ghost-2"] }]) {
        const settled = yield* settleTool(registry, call(input))
        const line = settled.result.type === "text" ? settled.result.value : ""
        expect(line.length).toBeGreaterThan(0)
        expect(line).toContain("succeeded")
        expect(line).toContain("marked 0 parts")
        expect(line).toContain("Do not call again")
      }
    }),
  )

  itEnabled.effect("counts only the ids matching eligible parts of the loaded history (T1.8)", () =>
    Effect.gen(function* () {
      yield* seed
      const registry = yield* ToolRegistry.Service

      const settled = yield* settleTool(registry, call({ ids: ["text-seed", "ghost-1"] }))
      expect(settled.result).toMatchObject({ type: "text", value: DiscardContextTool.successLine(1) })
    }),
  )

  itEnabled.effect("counts duplicate ids once (m1)", () =>
    Effect.gen(function* () {
      yield* seed
      const registry = yield* ToolRegistry.Service

      const settled = yield* settleTool(registry, call({ ids: ["text-seed", "text-seed"] }))
      expect(settled.result).toMatchObject({ type: "text", value: DiscardContextTool.successLine(1) })
    }),
  )

  itEnabled.effect("counts an attachment id as an eligible user part (T3.10)", () =>
    Effect.gen(function* () {
      yield* seed
      const registry = yield* ToolRegistry.Service

      const settled = yield* settleTool(registry, call({ ids: ["file-seed", "ghost"] }))
      expect(settled.result).toMatchObject({ type: "text", value: DiscardContextTool.successLine(1) })
    }),
  )
})
