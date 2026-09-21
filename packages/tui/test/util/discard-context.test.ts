import { describe, expect, test } from "bun:test"
import { discardedTokenTotal, formatCompactTokens } from "../../src/util/discard-context"
import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2"

let seq = 0

function textPart(messageID: string, text = "hello"): Part {
  return { id: `p${++seq}`, sessionID: "ses", messageID, type: "text", text }
}

function reasoningPart(messageID: string, text = "thinking"): Part {
  return { id: `p${++seq}`, sessionID: "ses", messageID, type: "reasoning", text, time: { start: 1 } }
}

function toolPart(messageID: string, tool: string, ids?: string[], output = "ok"): Part {
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
      output,
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
}

function assistant(id: string, output: number, reasoning: number, withTokens = true): AssistantMessage {
  const message = {
    id,
    sessionID: "ses",
    role: "assistant" as const,
    time: { created: 1 },
    parentID: "msg_u",
    modelID: "m",
    providerID: "p",
    mode: "",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    ...(withTokens ? { tokens: { input: 1, output, reasoning, cache: { read: 0, write: 0 } } } : {}),
  }
  // tokens is required in the SDK type but optional at runtime (streaming
  // messages); the cast documents the intentionally reduced shape.
  return message as AssistantMessage
}

function user(id: string): Message {
  return { id, sessionID: "ses", role: "user", agent: "build", model: { providerID: "p", modelID: "m" }, time: { created: 1 } }
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
  test("sums output and reasoning tokens of fully discarded assistant messages (T4.1)", () => {
    const message = assistant("msg_a", 3000, 1200)
    const parts = [textPart("msg_a"), reasoningPart("msg_a")]
    const ids = parts.map((part) => part.id)
    parts.push(toolPart("msg_a", "discard_context", ids))
    expect(discardedTokenTotal([message], partsOfIndex([message], parts))).toEqual({ total: 4200, estimated: false })
  })

  test("partially discarded messages contribute the floored char-weighted share (T4.2)", () => {
    // A7.2: a 300-char text part and a 100-char reasoning part with only the
    // text part marked contribute 3/4 of the output+reasoning tokens.
    const message = assistant("msg_a", 3000, 1200)
    const marked = textPart("msg_a", "x".repeat(300))
    const parts = [marked, reasoningPart("msg_a", "y".repeat(100)), toolPart("msg_a", "discard_context", [marked.id])]
    expect(discardedTokenTotal([message], partsOfIndex([message], parts))).toEqual({ total: 3150, estimated: true })
  })

  test("floors the partial share down to a whole token, never up", () => {
    const message = assistant("msg_a", 101, 0)
    const marked = textPart("msg_a", "x".repeat(300))
    const parts = [marked, reasoningPart("msg_a", "y".repeat(100)), toolPart("msg_a", "discard_context", [marked.id])]
    // floor(3/4 * 101) = 75 (R7.2).
    expect(discardedTokenTotal([message], partsOfIndex([message], parts))).toEqual({ total: 75, estimated: true })
  })

  test("weights a tool part by its output plus stringified input length", () => {
    const message = assistant("msg_a", 700, 0)
    const marked = toolPart("msg_a", "read", undefined, "")
    const parts = [textPart("msg_a"), marked, toolPart("msg_a", "discard_context", [marked.id])]
    // Tool weight: output "" (0) + JSON.stringify({}) (2); text "hello" is 5.
    // floor(2/7 * 700) = 200.
    expect(discardedTokenTotal([message], partsOfIndex([message], parts))).toEqual({ total: 200, estimated: true })
  })

  test("eligible parts weighing zero contribute zero and keep the total exact (A7.9)", () => {
    const message = assistant("msg_a", 500, 0)
    const marked = textPart("msg_a", "")
    const parts = [marked, textPart("msg_a", ""), toolPart("msg_a", "discard_context", [marked.id])]
    expect(discardedTokenTotal([message], partsOfIndex([message], parts))).toEqual({ total: 0, estimated: false })
  })

  test("a partial share floored to zero adds nothing and keeps the total exact", () => {
    const message = assistant("msg_a", 1, 0)
    const marked = textPart("msg_a", "x")
    const parts = [marked, textPart("msg_a", "y".repeat(999)), toolPart("msg_a", "discard_context", [marked.id])]
    // floor(1/1000 * 1) = 0: no nonzero share entered the total (R7.8).
    expect(discardedTokenTotal([message], partsOfIndex([message], parts))).toEqual({ total: 0, estimated: false })
  })

  test("mixes exact whole messages with one estimated partial share", () => {
    const full = assistant("msg_a", 1000, 0)
    const partial = assistant("msg_b", 800, 0)
    const fullMarked = textPart("msg_a")
    const partialMarked = textPart("msg_b", "x".repeat(300))
    const parts = [
      fullMarked,
      partialMarked,
      textPart("msg_b", "y".repeat(100)),
      toolPart("msg_a", "discard_context", [fullMarked.id, partialMarked.id]),
    ]
    const messages = [full, partial]
    // Exact 1000 + floor(3/4 * 800) = 600.
    expect(discardedTokenTotal(messages, partsOfIndex(messages, parts))).toEqual({ total: 1600, estimated: true })
  })

  test("discard_context markers do not close on themselves (T4.3)", () => {
    const message = assistant("msg_a", 500, 0)
    const marked = [textPart("msg_a"), toolPart("msg_a", "read")]
    const parts = [...marked, toolPart("msg_a", "discard_context", marked.map((part) => part.id))]
    expect(discardedTokenTotal([message], partsOfIndex([message], parts))).toEqual({ total: 500, estimated: false })
  })

  test("merges ids across multiple discard_context calls (T4.4)", () => {
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
    expect(discardedTokenTotal([message, other], partsOfIndex([message, other], parts))).toEqual({ total: 200, estimated: false })
  })

  test("returns 0 when nothing is discarded (T4.5)", () => {
    const message = assistant("msg_a", 999, 999)
    const parts = [textPart("msg_a")]
    expect(discardedTokenTotal([message], partsOfIndex([message], parts))).toEqual({ total: 0, estimated: false })
  })

  test("messages without tokens contribute nothing", () => {
    const message = assistant("msg_a", 0, 0, false)
    const marked = textPart("msg_a")
    const parts = [marked, toolPart("msg_b", "discard_context", [marked.id])]
    expect(discardedTokenTotal([message], partsOfIndex([message], parts))).toEqual({ total: 0, estimated: false })
  })

  test("non-assistant messages contribute nothing even when fully marked (T4.7)", () => {
    const message = user("msg_u")
    const marked = textPart("msg_u")
    const parts = [marked, toolPart("msg_b", "discard_context", [marked.id])]
    expect(discardedTokenTotal([message], partsOfIndex([message], parts))).toEqual({ total: 0, estimated: false })
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
