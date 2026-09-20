import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const name = "discard_context"

export const Parameters = Schema.Struct({
  ids: Schema.Array(Schema.String).annotate({
    description: "Ids of message parts (assistant text, reasoning, or tool call parts) to hide from the model context",
  }),
})

/**
 * V1 wrapper for the `discard_context` tool (specs/discard-context.md),
 * mirroring the V2 built-in in `@opencode-ai/core/tool/discard-context` with
 * the V1 `Tool.Def` shape. The call is the only side effect: settling it
 * persists the tool part with `input.ids` in session history, and the run
 * loop's context assembly (see `session/discard-context.ts`) collects those
 * ids from the reloaded history on every provider turn.
 *
 * Execution performs no permission assertion (spec R1.3): `execute` never
 * calls `ctx.ask` and performs no effect other than the durable persistence
 * of the tool part recorded by the caller (spec R1.4). The processor keeps
 * the persisted part's `tool` name equal to `name`, so existing tool-part
 * surfaces render it unchanged.
 */
export const DiscardContextTool = Tool.define(
  name,
  Effect.succeed({
    description:
      "Mark message parts as no longer needed by passing their part ids. Marked parts are hidden from your context in later turns but remain in the session history. Use it to drop superseded plans, stale reasoning, or bulky tool output you have already captured in your own words. Ids are the id fields of earlier assistant message parts; unknown ids are ignored.",
    parameters: Parameters,
    execute: (params: { ids: string[] }, _ctx: Tool.Context) =>
      Effect.succeed({
        title: "Discard context",
        metadata: {},
        output: `Marked ${params.ids.length} message part(s) to discard from context.`,
      }),
  }),
)
