export * as DiscardContext from "./discard-context"

import { SessionMessage } from "../message"
import { DiscardContextTool } from "../../tool/discard-context"

/**
 * System prompt instruction appended to provider requests while the
 * `discard_context` config flag is enabled. Explains when to call the tool,
 * where part ids come from (the projected-id-marker lines and provider tool
 * call ids), that parts of both assistant and user messages are markable, and
 * that marked parts stay in session history.
 */
export const INSTRUCTION =
  `You can call the \`discard_context\` tool to hide parts of this conversation from your own future context. Pass the ids of message parts that you no longer need: text, reasoning, or tool call parts of earlier assistant turns, or text or file parts of earlier user turns — superseded plans, stale exploration results, or bulky tool output you have already captured in your own words. Text and reasoning parts carry their id on a leading \`[part id: ...]\` line; tool calls are identified by their tool call ids. Marked parts will not appear in later turns, but they remain in the session history. Unknown ids are ignored, and the discard_context calls themselves are hidden as well.`

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
 * in the history, then removes: (a) assistant parts whose id is marked, (b)
 * the `discard_context` tool parts themselves, so a marked tool call and its
 * result always disappear together, and (c) marked parts of user messages —
 * the user text part is addressed by the user message's own id, a file
 * attachment by its attachment id (an attachment persisted without an id is
 * never addressable), and user parts are never matched by a tool call id
 * (R4.9). Assistant and user messages that become empty are dropped because
 * providers require alternating user/assistant turns (R4.4/R4.10). The most
 * recent user entry of the loaded history is never dropped and never loses
 * parts: marked ids naming its parts are ignored for the current pass,
 * because the runner reads the current turn's steering from the projected
 * history (R4.8). Unknown ids are ignored, other message types have no
 * addressable parts, and entry order is preserved.
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
  const lastUser = entries.findLast((entry) => entry.message.type === "user")
  return entries.flatMap((entry) => {
    const message = entry.message
    if (message.type === "user") {
      if (entry === lastUser) return [entry]
      const files = message.files ?? []
      // The user text part is addressed by the message id; a file attachment
      // by its attachment id; an attachment persisted without an id is never
      // addressable and is never removed (R4.9, attachment-id).
      const keptFiles = files.filter((file) => file.id === undefined || !marked.has(file.id))
      const textRemoved = marked.has(message.id) && message.text !== ""
      if (!textRemoved && keptFiles.length === files.length) return [entry]
      const text = textRemoved ? "" : message.text
      // A user message emptied by the marking drops (R4.4, A4.9); a message
      // that was already empty loses nothing and stays (mirror of the V1
      // filter's guard on messages with no removable parts).
      if (text === "" && keptFiles.length === 0) return []
      return [
        {
          ...entry,
          message: {
            ...message,
            text,
            ...(keptFiles.length === files.length ? {} : { files: keptFiles }),
          },
        },
      ]
    }
    if (message.type !== "assistant") return [entry]
    const content = message.content.filter((part) => !isDiscardCall(part) && !marked.has(part.id))
    if (content.length === 0) return []
    return [{ ...entry, message: { ...message, content } }]
  })
}
