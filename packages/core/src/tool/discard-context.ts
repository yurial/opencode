export * as DiscardContextTool from "./discard-context"

import { Effect, Layer, Schema } from "effect"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "discard_context"

export const Input = Schema.Struct({
  ids: Schema.Array(Schema.String).annotate({
    description: "Ids of message parts (assistant text, reasoning, or tool call parts) to hide from the model context",
  }),
})

export const Output = Schema.Struct({
  ids: Schema.Array(Schema.String),
})

/**
 * Marks message parts for exclusion from LLM context. The call itself is the
 * only side effect: settling it persists the tool part with `input.ids` in
 * session history, and the session runner's context assembly collects those
 * ids from history on every turn (see `session/runner/discard-context.ts`).
 *
 * Internal built-in-only operation: execution performs no permission
 * assertion; the registry's name-derived catalog action still lets rules
 * filter the whole tool definition.
 */
const tool = Tool.make({
  description:
    "Mark message parts as no longer needed by passing their part ids. Marked parts are hidden from your context in later turns but remain in the session history. Use it to drop superseded plans, stale reasoning, or bulky tool output you have already captured in your own words. Ids are the id fields of earlier assistant message parts; unknown ids are ignored.",
  input: Input,
  output: Output,
  toModelOutput: ({ output }) => [
    { type: "text", text: `Marked ${output.ids.length} message part(s) to discard from context.` },
  ],
  execute: (input) => Effect.succeed({ ids: input.ids }),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const config = yield* Config.Service
    // Registration is the visibility gate: with the flag off the tool never
    // reaches materialized definitions, so models never see it.
    if (Config.latest(yield* config.entries(), "discard_context") !== true) return
    yield* tools.register({ [name]: tool }).pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/discard-context",
  layer,
  deps: [ToolRegistry.node, Config.node],
})
