import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { DiscardContext } from "@/session/discard-context"
import { name } from "@/tool/discard-context"

const sessionID = SessionID.make("ses_discard_test")
const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const msgID = (id: string) => MessageID.make(`msg_${id}`)
const prtID = (id: string) => PartID.make(`prt_${id}`)

const user = (id: string): SessionV1.WithParts => ({
  info: {
    id: msgID(id),
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: ref.providerID, modelID: ref.modelID },
    time: { created: 0 },
  },
  parts: [],
})

const assistant = (id: string, parts: SessionV1.Part[]): SessionV1.WithParts => ({
  info: {
    id: msgID(id),
    role: "assistant",
    parentID: msgID("user_before"),
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: 0 },
  },
  parts,
})

const text = (id: string, value: string): SessionV1.TextPart => ({
  id: prtID(id),
  sessionID,
  messageID: msgID("owner"),
  type: "text",
  text: value,
})

const reasoning = (id: string, value: string): SessionV1.ReasoningPart => ({
  id: prtID(id),
  sessionID,
  messageID: msgID("owner"),
  type: "reasoning",
  text: value,
  time: { start: 0 },
})

const toolCall = (id: string, callID: string, tool: string, input: Record<string, unknown>): SessionV1.ToolPart => ({
  id: prtID(id),
  sessionID,
  messageID: msgID("owner"),
  type: "tool",
  callID,
  tool,
  state: { status: "completed", input, output: "result", title: tool, metadata: {}, time: { start: 0, end: 1 } },
})

const discardCall = (ids: readonly string[]) => toolCall("discard", "call-discard", name, { ids })

const pendingDiscardCall = (input: Record<string, unknown>): SessionV1.ToolPart => ({
  id: prtID("discard"),
  sessionID,
  messageID: msgID("owner"),
  type: "tool",
  callID: "call-discard",
  tool: name,
  state: { status: "pending", input, raw: "" },
})

const errorDiscardCall = (input: Record<string, unknown>): SessionV1.ToolPart => ({
  id: prtID("discard"),
  sessionID,
  messageID: msgID("owner"),
  type: "tool",
  callID: "call-discard",
  tool: name,
  state: { status: "error", input, error: "boom", time: { start: 0, end: 1 } },
})

const ids = (msgs: readonly SessionV1.WithParts[]) => msgs.flatMap((item) => item.parts.map((part) => part.id))

describe("session discard-context filterEntries", () => {
  test("removes marked parts by id, matches tool parts by provider call id, and hides discard calls", () => {
    const filtered = DiscardContext.filterEntries([
      user("user-1"),
      assistant("assistant-1", [
        text("text-1", "A"),
        reasoning("reasoning-1", "R"),
        toolCall("tool-1", "call-read", "read", { path: "README.md" }),
        text("text-2", "B"),
      ]),
      assistant("assistant-2", [discardCall([prtID("reasoning-1"), "call-read", "missing-id"])]),
      user("user-2"),
    ])

    expect(filtered).toHaveLength(3)
    expect(filtered[0]?.info.id).toBe(msgID("user-1"))
    expect(ids([filtered[1]!])).toEqual([prtID("text-1"), prtID("text-2")])
    expect(filtered[2]?.info.id).toBe(msgID("user-2"))
    expect(JSON.stringify(filtered)).not.toContain("README.md")
    expect(JSON.stringify(filtered)).not.toContain("call-discard")
  })

  test("drops assistant messages emptied by filtering", () => {
    const filtered = DiscardContext.filterEntries([
      user("user-1"),
      assistant("assistant-1", [text("text-1", "Only")]),
      assistant("assistant-2", [discardCall([prtID("text-1")])]),
    ])

    expect(filtered).toEqual([user("user-1")])
  })

  test("merges ids across multiple discard calls regardless of order", () => {
    const filtered = DiscardContext.filterEntries([
      assistant("assistant-1", [text("text-a", "A")]),
      assistant("assistant-2", [discardCall([prtID("text-a")])]),
      assistant("assistant-3", [toolCall("tool-1", "call-x", "bash", {}), text("text-b", "B")]),
      assistant("assistant-4", [discardCall(["call-x", prtID("text-a")])]),
    ])

    expect(ids(filtered)).toEqual([prtID("text-b")])
  })

  test("preserves order and leaves non-assistant messages unchanged", () => {
    const first = user("user-1")
    const last = user("user-2")
    const filtered = DiscardContext.filterEntries([
      first,
      assistant("assistant-1", [text("text-1", "A")]),
      assistant("assistant-2", [discardCall([prtID("text-1")])]),
      last,
    ])

    expect(filtered).toHaveLength(2)
    expect(filtered[0]).toBe(first)
    expect(filtered[1]).toBe(last)
  })

  test("returns the input array unchanged when history has no discard calls", () => {
    const msgs = [user("user-1"), assistant("assistant-1", [text("text-1", "A")])]

    expect(DiscardContext.filterEntries(msgs)).toBe(msgs)
  })

  test("reads ids from the decoded input for every call status and empty pending input contributes nothing", () => {
    const pendingParsed = DiscardContext.filterEntries([
      user("user-1"),
      assistant("assistant-1", [text("text-1", "Marked"), text("text-2", "Stay")]),
      assistant("assistant-2", [pendingDiscardCall({ ids: [prtID("text-1")] })]),
    ])
    expect(ids(pendingParsed)).toEqual([prtID("text-2")])

    const errorParsed = DiscardContext.filterEntries([
      user("user-1"),
      assistant("assistant-1", [text("text-1", "Marked"), text("text-2", "Stay")]),
      assistant("assistant-2", [errorDiscardCall({ ids: [prtID("text-1")] })]),
    ])
    expect(ids(errorParsed)).toEqual([prtID("text-2")])

    const notLaunched = DiscardContext.filterEntries([
      user("user-1"),
      assistant("assistant-1", [text("text-1", "Stay")]),
      assistant("assistant-2", [pendingDiscardCall({})]),
    ])
    expect(ids(notLaunched)).toEqual([prtID("text-1")])
  })

  test("ignores non-string id elements and malformed input", () => {
    const nonStrings = DiscardContext.filterEntries([
      user("user-1"),
      assistant("assistant-1", [text("text-1", "Marked"), text("text-2", "Stay")]),
      assistant("assistant-2", [discardCall([prtID("text-1"), 42 as unknown as string])]),
    ])
    expect(ids(nonStrings)).toEqual([prtID("text-2")])

    const malformed = DiscardContext.filterEntries([
      user("user-1"),
      assistant("assistant-1", [text("text-1", "Stay")]),
      assistant("assistant-2", [toolCall("discard", "call-discard", name, { ids: "nope" })]),
      assistant("assistant-3", [toolCall("discard-2", "call-discard-2", name, {})]),
    ])
    expect(ids(malformed)).toEqual([prtID("text-1")])
  })

  test("ignores unknown ids and keeps addressable-looking parts of non-assistant messages", () => {
    const stranger = text("text-stranger", "user-owned")
    const userMsg = user("user-1")
    userMsg.parts.push(stranger)
    const filtered = DiscardContext.filterEntries([
      userMsg,
      assistant("assistant-1", [text("text-1", "A")]),
      assistant("assistant-2", [discardCall([prtID("text-stranger"), "missing-1"])]),
    ])

    expect(ids(filtered)).toEqual([prtID("text-stranger"), prtID("text-1")])
  })
})
