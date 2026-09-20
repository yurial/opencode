import { Effect, Schema } from "effect"
import { successLine } from "@opencode-ai/core/tool/discard-context"
import { NotFoundError } from "@/storage/storage"
import { Session } from "@/session/session"
import * as Tool from "./tool"

export const name = "discard_context"

export const Parameters = Schema.Struct({
  ids: Schema.Array(Schema.String).annotate({
    description:
      "Ids of message parts to hide from the model context: text, reasoning, or tool call parts of earlier assistant turns, or text or file parts of earlier user turns",
  }),
})

// The V2 filter's types bind to the V2 message shapes, so the eligibility
// check is mirrored here like filterEntries is mirrored in
// `session/discard-context.ts` (spec Usage constraints). Assistant tool parts
// are also addressable through their provider call id (R4.7); user text and
// file parts only through their own part id (R4.9). V2 user file attachments
// carry no id, so they are unaddressable there but addressable here.
const matchedCount = (ids: readonly string[], msgs: Tool.Context["messages"]): number => {
  if (ids.length === 0) return 0
  const addressable = new Set<string>()
  for (const { info, parts } of msgs) {
    if (info.role !== "assistant") {
      for (const part of parts) {
        if ((part.type === "text" && part.text !== "") || part.type === "file") addressable.add(part.id)
      }
      continue
    }
    for (const part of parts) {
      if (part.type === "text" || part.type === "reasoning") addressable.add(part.id)
      if (part.type === "tool") {
        addressable.add(part.id)
        addressable.add(part.callID)
      }
    }
  }
  return [...new Set(ids)].filter((id) => addressable.has(id)).length
}

/**
 * V1 wrapper for the `discard_context` tool (specs/discard-context.md),
 * mirroring the V2 built-in in `@opencode-ai/core/tool/discard-context` with
 * the V1 `Tool.Def` shape. The call is the only side effect: settling it
 * persists the tool part with `input.ids` in session history, and the run
 * loop's context assembly (see `session/discard-context.ts`) collects those
 * ids from the reloaded history on every provider turn.
 *
 * The settled output is the core `successLine` (R1.2/R1.7/R1.8) over the
 * count of ids naming parts eligible for marking in the durable loaded
 * history — the same durable reading the V2 built-in takes, so matched
 * counts agree across runtimes. History is re-read from the session service;
 * `ctx.messages` (the loop's filtered view) only backs the impossible case of
 * a missing session.
 *
 * Execution performs no permission assertion (spec R1.3): `execute` never
 * calls `ctx.ask` and performs no effect other than the durable persistence
 * of the tool part recorded by the caller (spec R1.4). The processor keeps
 * the persisted part's `tool` name equal to `name`, so existing tool-part
 * surfaces render it unchanged.
 */
export const DiscardContextTool = Tool.define(
  name,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description:
        "Mark message parts as no longer needed by passing their part ids. Marked parts are hidden from your context in later turns but remain in the session history. Use it to drop superseded plans, stale reasoning, or bulky tool output you have already captured in your own words. Ids are the id fields of earlier message parts: text, reasoning, or tool call parts of your earlier turns, or text or file parts of earlier user turns; text parts carry their id on a leading [part id: ...] line and tool calls are identified by their call ids. Unknown ids are ignored.",
      parameters: Parameters,
      execute: (params: { ids: string[] }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const history = yield* sessions
            .messages({ sessionID: ctx.sessionID })
            .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(ctx.messages)))
          return {
            title: "Discard context",
            metadata: {},
            output: successLine(matchedCount(params.ids, history)),
          }
        }),
    }
  }),
)
