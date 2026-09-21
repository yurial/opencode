/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2"
import discardStats from "../../src/feature-plugins/sidebar/discard-stats"
import { discardedTokenTotal, formatCompactTokens } from "../../src/util/discard-context"
import { createTuiPluginApi } from "../fixture/tui-plugin"

let seq = 0

function textPart(messageID: string, text = "hello"): Part {
  return { id: `part-${++seq}`, sessionID: "ses", messageID, type: "text", text }
}

function reasoningPart(messageID: string, text: string): Part {
  return { id: `part-${++seq}`, sessionID: "ses", messageID, type: "reasoning", text, time: { start: 1 } }
}

function toolPart(messageID: string, tool: string, output = "ok"): Part {
  return {
    id: `part-${++seq}`,
    sessionID: "ses",
    messageID,
    type: "tool",
    callID: `call${seq}`,
    tool,
    state: {
      status: "completed",
      input: {},
      output,
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
}

function discardCall(messageID: string, input: Record<string, unknown>): Part {
  return {
    id: `part-${++seq}`,
    sessionID: "ses",
    messageID,
    type: "tool",
    callID: `call${seq}`,
    tool: "discard_context",
    state: {
      status: "completed",
      input,
      output: "ok",
      title: "discard_context",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
}

function assistant(id: string, output: number, reasoning: number): AssistantMessage {
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
    tokens: { input: 1, output, reasoning, cache: { read: 0, write: 0 } },
  }
  return message as AssistantMessage
}

function user(id: string): Message {
  return { id, sessionID: "ses", role: "user", agent: "build", model: { providerID: "p", modelID: "m" }, time: { created: 1 } }
}

// In-memory projection of the sync store the widget reads through
// api.state (message[sessionID] / part[messageID]); no other state exists.
type Store = {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
}

function storeOf(messages: Message[], parts: Part[]): Store {
  const store: Store = { message: { ses: messages }, part: {} }
  for (const part of parts) {
    store.part[part.messageID] = [...(store.part[part.messageID] ?? []), part]
  }
  return store
}

function byMessage(messages: Message[], parts: Part[]) {
  const byID = new Map<string, Part[]>()
  for (const part of parts) {
    const list = byID.get(part.messageID) ?? []
    list.push(part)
    byID.set(part.messageID, list)
  }
  return (messageID: string) => byID.get(messageID)
}

// Activates the plugin against a captured slots.register and renders the
// registered sidebar_content slot, mirroring the host flow in
// packages/opencode/src/plugin/tui/runtime.ts.
async function renderSidebar(store: Store) {
  let view: ((ctx: unknown, props: { session_id: string }) => JSX.Element) | undefined
  const base = createTuiPluginApi()
  const api = {
    ...base,
    state: {
      ...base.state,
      session: {
        ...base.state.session,
        messages: (sessionID: string) => store.message[sessionID] ?? [],
      },
      part: (messageID: string) => store.part[messageID] ?? [],
    },
    slots: {
      register(plugin: { slots: Record<string, unknown> }) {
        view = plugin.slots.sidebar_content as (ctx: unknown, props: { session_id: string }) => JSX.Element
        return "internal:sidebar-discard-stats"
      },
    },
  } as unknown as TuiPluginApi

  await discardStats.tui(api, undefined, {
    id: "internal:sidebar-discard-stats",
    source: "internal",
    spec: "internal:sidebar-discard-stats",
    target: "internal:sidebar-discard-stats",
    first_time: 0,
    last_time: 0,
    time_changed: 0,
    load_count: 1,
    fingerprint: "test",
    state: "same",
  })
  if (!view) throw new Error("sidebar_content slot was not registered")

  const app = await testRender(() => view!({ theme: undefined }, { session_id: "ses" }), { width: 48, height: 12 })
  try {
    await settled(app)
    return await captureFrame(app)
  } finally {
    app.renderer.destroy()
  }
}

async function settled(app: Awaited<ReturnType<typeof testRender>>) {
  await app.renderOnce()
  await new Promise((resolve) => setTimeout(resolve, 25))
  await app.renderOnce()
}

async function captureFrame(app: Awaited<ReturnType<typeof testRender>>) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const frame = app.captureCharFrame()
    if (frame.trim().length > 0) return frame
    await new Promise((resolve) => setTimeout(resolve, 25))
    await app.renderOnce()
  }
  return app.captureCharFrame()
}

describe("sidebar discard statistics", () => {
  test("renders the three rows from the session history (T7.1)", async () => {
    const message = assistant("msg_a", 4200, 0)
    const markedText = textPart("msg_a")
    const markedTool = toolPart("msg_a", "read")
    const parts = [markedText, markedTool, discardCall("msg_a", { ids: [markedText.id, markedTool.id] })]
    const frame = await renderSidebar(storeOf([message], parts))

    expect(frame).toContain("Discarded: 2 parts")
    expect(frame).toContain("4.2k tokens")
    expect(frame).toContain("1 call")
    // The marked ids themselves are never rendered (R9.1).
    expect(frame).not.toContain(markedText.id)
    expect(frame).not.toContain(markedTool.id)
  })

  test("token row equals the marker-surface total and carries ~ exactly when estimated (T7.2)", async () => {
    // A7.2: only the 300-char text part is marked of a 400-char message, so
    // the total is the estimated floored share 3/4 * 4200 = 3150.
    const partial = assistant("msg_a", 3000, 1200)
    const partialMarked = textPart("msg_a", "x".repeat(300))
    const partialParts = [
      partialMarked,
      reasoningPart("msg_a", "y".repeat(100)),
      discardCall("msg_a", { ids: [partialMarked.id] }),
    ]
    const partialFrame = await renderSidebar(storeOf([partial], partialParts))
    const partialTotal = discardedTokenTotal([partial], byMessage([partial], partialParts))
    const partialLabel = `${partialTotal.estimated ? "~" : ""}${formatCompactTokens(partialTotal.total)} tokens`
    // (3.15).toFixed(1) renders "3.1": the util rounds the compact form of 3150 down.
    expect(partialLabel).toBe("~3.1k tokens")
    expect(partialFrame).toContain("~3.1k tokens")

    // A fully marked message contributes exact whole-message tokens: no ~.
    const exact = assistant("msg_a", 1000, 0)
    const exactMarked = textPart("msg_a")
    const exactParts = [exactMarked, discardCall("msg_a", { ids: [exactMarked.id] })]
    const exactFrame = await renderSidebar(storeOf([exact], exactParts))
    const exactTotal = discardedTokenTotal([exact], byMessage([exact], exactParts))
    const exactLabel = `${exactTotal.estimated ? "~" : ""}${formatCompactTokens(exactTotal.total)} tokens`
    expect(exactLabel).toBe("1k tokens")
    expect(exactFrame).toContain("1k tokens")
    expect(exactFrame).not.toContain("~1k tokens")
  })

  test("renders no block when the history marks nothing (T7.3, A9.4)", async () => {
    const message = assistant("msg_a", 999, 999)
    const parts = [textPart("msg_a"), toolPart("msg_a", "read")]
    const frame = await renderSidebar(storeOf([user("msg_u"), message], parts))
    expect(frame.trim()).toBe("")
  })

  test("toggling sidebar visibility changes no value (T7.4)", async () => {
    const message = assistant("msg_a", 1000, 0)
    const markedText = textPart("msg_a")
    const store = storeOf([message], [markedText, discardCall("msg_a", { ids: [markedText.id] })])
    // Hiding and showing remounts the widget; it holds no state of its own
    // (R9.3), so a fresh render of the same store shows the same values.
    const first = await renderSidebar(store)
    const second = await renderSidebar(store)
    expect(second).toBe(first)
    expect(first).toContain("Discarded: 1 part")
    expect(first).toContain("1k tokens")
    expect(first).toContain("1 call")
  })

  test("collapses the union across multiple calls; unknown ids are not marked parts (A9.1, R3.1)", async () => {
    const first = textPart("msg_a")
    const second = textPart("msg_a", "second")
    const parts = [
      first,
      second,
      discardCall("msg_b", { ids: [first.id] }),
      discardCall("msg_b", { ids: [first.id, second.id] }),
      discardCall("msg_b", { ids: [second.id, "part-unknown"] }),
    ]
    const frame = await renderSidebar(storeOf([user("msg_a"), assistant("msg_b", 0, 0)], parts))

    expect(frame).toContain("Discarded: 2 parts")
    expect(frame).toContain("3 calls")
  })

  test("a malformed call counts as a call and never fails the render (R9.1, error handling)", async () => {
    const marked = textPart("msg_a")
    // Missing ids array: contributes nothing to the union, still a call.
    const malformed = discardCall("msg_b", {})
    const parts = [marked, malformed, discardCall("msg_b", { ids: [marked.id] })]
    const frame = await renderSidebar(storeOf([user("msg_a"), assistant("msg_b", 0, 0)], parts))

    expect(frame).toContain("Discarded: 1 part")
    expect(frame).toContain("2 calls")
  })
})
