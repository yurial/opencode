export * as DiscardContextTool from "./discard-context"

import { Effect, Layer, Schema } from "effect"
import type { SessionMessage } from "../session/message"
import { SessionStore } from "../session/store"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "discard_context"

export const Input = Schema.Struct({
  ids: Schema.Array(Schema.String).annotate({
    description:
      "Ids of message parts to hide from the model context: text, reasoning, or tool call parts of earlier assistant turns, or text or file parts of earlier user turns",
  }),
})

/** Structured output channel: the settled call echoes its input ids (R1.1). */
export const Output = Schema.Struct({
  ids: Schema.Array(Schema.String),
})

const SettledOutput = Schema.Struct({
  ids: Schema.Array(Schema.String),
  matched: Schema.Number,
})

/**
 * The fixed model-facing line of a settled call (R1.2/R1.7/R1.8): always
 * non-empty, confirms success, states the matched count, and for a zero count
 * forbids repeating the call without ids of new parts. Single source for both
 * runtimes; the V1 tool imports this exact function.
 */
export const successLine = (matched: number): string =>
  matched > 0
    ? `discard_context succeeded: marked ${matched} part(s) for exclusion from future context.`
    : `discard_context succeeded: marked 0 parts (ids empty, unknown, or ineligible). Do not call again unless you have ids of new parts to mark.`

/**
 * Counts how many of the call's ids name a part eligible for marking in the
 * loaded history (R1.2): assistant text, reasoning, and tool parts by their
 * part id (which is the provider call id in V2), user text parts by the user
 * message id, and user file attachments by their attachment id — an
 * attachment persisted without an id is never eligible. Duplicate ids count
 * once. Ids already marked by earlier calls still count: eligibility is
 * decided against durable history.
 */
export const matchedCount = (ids: readonly string[], messages: readonly SessionMessage.Message[]): number => {
  if (ids.length === 0) return 0
  const addressable = new Set<string>()
  for (const message of messages) {
    if (message.type === "assistant") {
      for (const part of message.content) addressable.add(part.id)
    }
    if (message.type === "user") {
      if (message.text !== "") addressable.add(message.id)
      for (const file of message.files ?? []) {
        if (file.id !== undefined) addressable.add(file.id)
      }
    }
  }
  return [...new Set(ids)].filter((id) => addressable.has(id)).length
}

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
const tool = (store: SessionStore.Interface) =>
  Tool.make({
    description:
      "Mark message parts as no longer needed by passing their part ids. Marked parts are hidden from your context in later turns but remain in the session history. Use it to drop superseded plans, stale reasoning, or bulky tool output you have already captured in your own words. Ids are the id fields of earlier message parts: text, reasoning, or tool call parts of your earlier turns, or text or file parts of earlier user turns; text parts carry their id on a leading [part id: ...] line and tool calls are identified by their call ids. Unknown ids are ignored.",
    input: Input,
    output: SettledOutput,
    structured: Output,
    toStructuredOutput: ({ input }) => ({ ids: input.ids }),
    toModelOutput: ({ output }) => [{ type: "text", text: successLine(output.matched) }],
    execute: (input, context) =>
      Effect.gen(function* () {
        const history = yield* store.context(context.sessionID)
        return { ids: input.ids, matched: matchedCount(input.ids, history) }
      }).pipe(
        Effect.mapError((error: { readonly message: string }) => new Tool.Failure({ message: error.message })),
      ),
  })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const config = yield* Config.Service
    const store = yield* SessionStore.Service
    // Registration is the visibility gate: with the flag off the tool never
    // reaches materialized definitions, so models never see it.
    if (Config.latest(yield* config.entries(), "discard_context") !== true) return
    yield* tools.register({ [name]: tool(store) }).pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/discard-context",
  layer,
  deps: [ToolRegistry.node, Config.node, SessionStore.node],
})
