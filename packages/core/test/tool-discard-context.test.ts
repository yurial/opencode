import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV2 } from "@opencode-ai/core/session"
import { DiscardContextTool } from "@opencode-ai/core/tool/discard-context"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

// Each harness compiles an independent layer so the construction-time
// registration gate sees a fixed config regardless of test order.
const harness = (discardContext: boolean) =>
  testEffect(
    AppNodeBuilder.build(
      LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, DiscardContextTool.node]),
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

const call = (input: unknown, id = "call-discard") => ({
  sessionID: SessionV2.ID.make("ses_discard_tool_test"),
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: DiscardContextTool.name, input },
})

describe("DiscardContextTool", () => {
  itDisabled.effect("does not register when discard_context is disabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([])
    }),
  )

  itEnabled.effect("registers when enabled and marks part ids without permission assertions", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = ["msg_text_1", "call_read_1"]

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([DiscardContextTool.name])
      expect(yield* settleTool(registry, call({ ids }))).toEqual({
        result: { type: "text", value: "Marked 2 message part(s) to discard from context." },
        output: {
          structured: { ids },
          content: [{ type: "text", text: "Marked 2 message part(s) to discard from context." }],
        },
      })
    }),
  )

  itEnabled.effect("rejects invalid input", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      for (const input of [{}, { ids: "msg_text_1" }, { ids: ["msg_text_1", 42] }]) {
        expect(yield* executeTool(registry, call(input))).toMatchObject({
          type: "error",
          value: expect.stringContaining("Invalid tool input"),
        })
      }
    }),
  )
})
