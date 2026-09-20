import { SessionV1 } from "@opencode-ai/core/v1/session"

import { name } from "../tool/discard-context"

// The fixed instruction text lives in the core module; the run loop appends it
// to the per-turn system parts while the flag is enabled (spec R2.9).
export { INSTRUCTION } from "@opencode-ai/core/session/runner/discard-context"

const markedIDs = (input: unknown): readonly string[] => {
  if (typeof input !== "object" || input === null || !("ids" in input) || !Array.isArray(input.ids)) return []
  return input.ids.filter((id): id is string => typeof id === "string")
}

const isDiscardCall = (part: SessionV1.Part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === name

/**
 * V1 history filter for the `discard_context` tool (specs/discard-context.md).
 *
 * Semantic mirror of `DiscardContext.filterEntries` in
 * `@opencode-ai/core/session/runner/discard-context`. It is kept as a copy
 * because the core module's types bind to the V2 message shapes; any change
 * here must keep the two semantically identical (spec, Usage constraints).
 *
 * Contract:
 * - Collects the deduplicated union of string ids marked by every
 *   `discard_context` tool part in the loaded history, independent of call
 *   order. Ids are read from the decoded input record for every call status
 *   (spec R3.5); a call whose input carries no ids array, or whose ids are not
 *   strings, contributes nothing. V1 never parses raw pending JSON.
 * - Removes from assistant messages every part whose id is marked, every tool
 *   part whose provider call id (`callID`) is marked — the model only sees
 *   provider tool-call ids (spec R4.7) — and the discard calls themselves, so
 *   a marked tool call and its result disappear together.
 * - Drops assistant messages whose parts become empty (providers require
 *   alternating user/assistant turns), preserves message order, and leaves
 *   non-assistant messages unchanged.
 * - Returns the input array unchanged when the history has no discard calls.
 * - Never fails: malformed inputs only narrow what is filtered.
 *
 * The run loop applies this right after reloading history, before lowering
 * and before both compaction paths (spec R5.5/R5.6).
 */
export const filterEntries = (msgs: SessionV1.WithParts[]): SessionV1.WithParts[] => {
  const marked = new Set<string>()
  let hasDiscardCalls = false
  for (const { info, parts } of msgs) {
    if (info.role !== "assistant") continue
    for (const part of parts) {
      if (!isDiscardCall(part)) continue
      hasDiscardCalls = true
      for (const id of markedIDs(part.state.input)) marked.add(id)
    }
  }
  if (!hasDiscardCalls) return msgs
  return msgs.flatMap((msg) => {
    if (msg.info.role !== "assistant") return [msg]
    // A marked id removes a tool part under either name: the part's own id or
    // the provider tool-call id the model actually sees (spec R4.7).
    const parts = msg.parts.filter((part) => {
      if (part.type === "tool" && marked.has(part.callID)) return false
      return !isDiscardCall(part) && !marked.has(part.id)
    })
    if (parts.length === 0) return []
    return [{ ...msg, parts }]
  })
}

export * as DiscardContext from "./discard-context"
