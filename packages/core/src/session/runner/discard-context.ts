export * as DiscardContext from "./discard-context"

import { SessionMessage } from "../message"
import { DiscardContextTool } from "../../tool/discard-context"

/**
 * System prompt instruction appended to provider requests while the
 * `discard_context` config flag is enabled. Explains when to call the tool,
 * where part ids come from, and that marked parts stay in session history.
 */
export const INSTRUCTION =
  `You can call the \`discard_context\` tool to hide parts of this conversation from your own future context. Pass the ids of message parts (assistant text, reasoning, or tool call parts from earlier turns) that you no longer need: superseded plans, stale exploration results, or bulky tool output you have already captured in your own words. Marked parts will not appear in later turns, but they remain in the session history. Unknown ids are ignored, and the discard_context calls themselves are hidden as well.`

const isDiscardCall = (part: SessionMessage.AssistantContent): part is SessionMessage.AssistantTool =>
  part.type === "tool" && part.name === DiscardContextTool.name

const markedIDs = (input: unknown): readonly string[] => {
  if (typeof input !== "object" || input === null || !("ids" in input) || !Array.isArray(input.ids)) return []
  return input.ids.filter((id): id is string => typeof id === "string")
}

const callIDs = (state: SessionMessage.ToolState): readonly string[] => {
  // A pending tool call persists its input as the raw JSON string that the
  // provider streamed; settled calls hold the decoded record.
  if (state.status === "pending") {
    try {
      return markedIDs(JSON.parse(state.input))
    } catch {
      return []
    }
  }
  return markedIDs(state.input)
}

export interface Entry {
  readonly seq: number
  readonly message: SessionMessage.Message
}

/**
 * Projects runner history entries down to the parts that may reach the LLM.
 *
 * Collects the union of part ids marked by every `discard_context` tool call
 * in the history, then removes: (a) assistant parts whose id is marked, and
 * (b) the `discard_context` tool parts themselves, so a marked tool call and
 * its result always disappear together. Assistant messages that become empty
 * are dropped because providers require alternating user/assistant turns.
 * Unknown ids are ignored, non-assistant messages have no addressable parts,
 * and entry order is preserved.
 *
 * The runner applies this right after loading entries from the database, so
 * it also applies after resume, and before compaction so marked content is
 * never baked into a summary.
 */
export const filterEntries = (entries: readonly Entry[]): readonly Entry[] => {
  const marked = new Set<string>()
  let hasDiscardCalls = false
  for (const { message } of entries) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (!isDiscardCall(part)) continue
      hasDiscardCalls = true
      for (const id of callIDs(part.state)) marked.add(id)
    }
  }
  if (!hasDiscardCalls) return entries
  return entries.flatMap((entry) => {
    const message = entry.message
    if (message.type !== "assistant") return [entry]
    const content = message.content.filter((part) => !isDiscardCall(part) && !marked.has(part.id))
    if (content.length === 0) return []
    return [{ ...entry, message: { ...message, content } }]
  })
}
