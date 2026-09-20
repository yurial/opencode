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
 * - Removes from user messages every text or file part whose own part id is
 *   marked; provider-call-id matching never applies to user parts (spec
 *   R4.9), and other user part types are never removable.
 * - Drops assistant and user messages whose parts become empty (providers
 *   require alternating user/assistant turns), preserves message order.
 * - Never drops the most recent user entry and never removes all of its
 *   parts: marked ids naming its parts are ignored for the current pass,
 *   because the loop reads the current turn's steering from the projected
 *   history (spec R4.8).
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
  const lastUserIndex = msgs.findLastIndex((msg) => msg.info.role === "user")
  return msgs.flatMap((msg, index) => {
    if (msg.info.role === "user") {
      if (index === lastUserIndex) return [msg]
      const parts = msg.parts.filter((part) => {
        if (part.type !== "text" && part.type !== "file") return true
        return !marked.has(part.id)
      })
      // Only a message emptied BY the filtering drops; a message with no
      // removable parts (including already empty ones) stays unchanged. V1
      // user messages are matched by part id, so an empty one is never
      // markable; the V2 mirror keeps its already-empty marked messages for
      // the same reason.
      if (parts.length === 0 && msg.parts.length > 0) return []
      return parts.length === msg.parts.length ? [msg] : [{ ...msg, parts }]
    }
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
