import { describe, expect, test } from "bun:test"
import { discardedTokenTotal, formatCompactTokens } from "../../src/util/discard-context"
import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2"

let seq = 0

function textPart(messageID: string): Part {
  return { id: `p${++seq}`, sessionID: "ses", messageID, type: "text", text: "hello" }
}

function reasoningPart(messageID: string): Part {
  return { id: `p${++seq}`, sessionID: "ses", messageID, type: "reasoning", text: "thinking", time: { start: 1 } }
}

function toolPart(messageID: string, tool: string, ids?: string[]): Part {
  return {
    id: `p${++seq}`,
    sessionID: "ses",
    messageID,
    type: "tool",
    callID: `call${seq}`,
    tool,
    state: {
      status: "completed",
      input: ids ? { ids } : {},
      output: "ok",
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
}

function assistant(id: string, output: number, reasoning: number): AssistantMessage {
  return {
    id,
    sessionID: "ses",
    role: "assistant",
    time: { created: 1 },
    parentID: "msg_u",
    modelID: "m",
    providerID: "p",
    mode: "",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 1, output, reasoning, cache: { read: 0, write: 0 } },
  }
}

function partsOfIndex(messages: Message[], parts: Part[]) {
  const byID = new Map<string, Part[]>()
  for (const part of parts) {
    const list = byID.get(part.messageID) ?? []
    list.push(part)
    byID.set(part.messageID, list)
  }
  return (messageID: string) => byID.get(messageID)
}

describe("discardedTokenTotal", () => {
  test("sums output and reasoning tokens of fully discarded assistant messages", () => {
    const message = assistant("msg_a", 3000, 1200)
    const parts = [textPart("msg_a"), reasoningPart("msg_a")]
    const ids = parts.map((part) => part.id)
    parts.push(toolPart("msg_a", "discard_context", ids))
    expect(discardedTokenTotal([message], partsOfIndex([message], parts))).toBe(4200)
  })

  test("partially discarded messages contribute nothing", () => {
    const message = assistant("msg_a", 3000, 1200)
    const first = textPart("msg_a")
    const parts = [first, reasoningPart("msg_a"), toolPart("msg_a", "discard_context", [first.id])]
    expect(discardedTokenTotal([message], partsOfIndex([message], parts))).toBe(0)
  })

  test("discard_context markers do not close on themselves", () => {
    const message = assistant("msg_a", 500, 0)
    const marked = [textPart("msg_a"), toolPart("msg_a", "read")]
    const parts = [...marked, toolPart("msg_a", "discard_context", marked.map((part) => part.id))]
    expect(discardedTokenTotal([message], partsOfIndex([message], parts))).toBe(500)
  })

  test("merges ids across multiple discard_context calls", () => {
    const message = assistant("msg_a", 100, 100)
    const other = assistant("msg_b", 0, 0)
    const first = textPart("msg_a")
    const second = reasoningPart("msg_a")
    const parts = [
      first,
      second,
      toolPart("msg_b", "discard_context", [first.id]),
      toolPart("msg_b", "discard_context", [second.id]),
    ]
    expect(discardedTokenTotal([message, other], partsOfIndex([message, other], parts))).toBe(200)
  })

  test("returns 0 when nothing is discarded", () => {
    const message = assistant("msg_a", 999, 999)
    const parts = [textPart("msg_a")]
    expect(discardedTokenTotal([message], partsOfIndex([message], parts))).toBe(0)
  })
})

describe("formatCompactTokens", () => {
  test("keeps small counts as-is", () => {
    expect(formatCompactTokens(0)).toBe("0")
    expect(formatCompactTokens(42)).toBe("42")
    expect(formatCompactTokens(999)).toBe("999")
  })

  test("rolls over to k with one decimal", () => {
    expect(formatCompactTokens(1000)).toBe("1k")
    expect(formatCompactTokens(4200)).toBe("4.2k")
    expect(formatCompactTokens(12500)).toBe("12.5k")
  })

  test("rolls over to M with one decimal", () => {
    expect(formatCompactTokens(1_000_000)).toBe("1M")
    expect(formatCompactTokens(1_300_000)).toBe("1.3M")
  })
})
