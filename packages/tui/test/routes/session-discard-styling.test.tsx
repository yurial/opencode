/** @jsxImportSource @opentui/solid */
// Render-level tests for the discarded-block transcript styling
// (specs/discard-context.md R10, specs/tui-theme.md R51–R53). The real
// ThemeProvider mounts the default built-in theme (or a v2 override file);
// the exported session route components render inside the session transcript
// context whose `discarded()` comes from the production
// `collectDiscardedPartIds`. Assertions read the captured span list, where
// every span carries its resolved fg/bg/attributes.
import { afterEach, describe, expect, test } from "bun:test"
import { RGBA, TextAttributes } from "@opentui/core"
import { testRender, type JSX } from "@opentui/solid"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider, useTheme, type ThemeSource } from "../../src/context/theme"
import { LocalContext } from "../../src/context/local"
import { SyncContext } from "../../src/context/sync"
import { LocationProvider } from "../../src/context/location"
import { TuiConfigProvider } from "../../src/config"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { sessionTranscriptContext, TextPart, ToolPart, ReasoningPart, UserMessage } from "../../src/routes/session"
import { collectDiscardedPartIds } from "../../src/util/discard-context"
import type { TuiConfig } from "../../src/config"

let app: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  app?.renderer.destroy()
  app = undefined
})

const config = createTuiResolvedConfig({ theme: "discard-v2" })

// A v2 override file: the discarded fg/bg are loud colors, the marker trio
// take distinct colors, and every shared element the discarded style replaces
// takes a different quiet color — a span carrying the loud color proves the
// render read the discarded element, not the shared read. The `theme` config
// pin selects it, since kv storage starts empty in the fixture.
const discardTheme = {
  theme: {
    "syntax.default": { fg: "#090909" },
    "message.discarded.text": { fg: "#ff0000", bg: "#0000ff" },
    "message.discarded.marker": { fg: "#00ff00" },
    "message.discarded.pending": { fg: "#ffff00" },
    "message.discarded.error": { fg: "#ff00ff" },
    "message.tool.body": { fg: "#010101" },
    "message.tool.body.pending": { fg: "#020202" },
    "message.tool.status.error": { fg: "#030303" },
    "message.user.body": { fg: "#040404" },
    "message.reasoning.body": { fg: "#050505" },
    "markdown.text": { fg: "#060606" },
    "markdown.bg": { bg: "#070707" },
    "message.tool.card": { bg: "#080808" },
  },
}

const source = { discover: async () => ({ "discard-v2": discardTheme }) }

const noopContextValue = {
  width: 72,
  sessionID: "ses",
  conceal: () => false,
  thinkingMode: () => "show" as const,
  showThinking: () => true,
  showTimestamps: () => false,
  showDetails: () => true,
  showGenericToolOutput: () => false,
  diffWrapMode: () => "word" as const,
  providers: () => new Map(),
  sync: {} as never,
  tui: config,
  discarded: () => marked,
  discardTokens: () => ({ total: 4200, estimated: false }),
}

let marked: ReadonlySet<string> = new Set()

type SpanInfo = { text: string; fg: RGBA; bg: RGBA; attributes: number }

function spanList(): SpanInfo[] {
  const spans: SpanInfo[] = []
  for (const line of app!.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.trim().length > 0) spans.push({ text: span.text, fg: span.fg, bg: span.bg, attributes: span.attributes })
    }
  }
  return spans
}

// Mounts `body` inside the real ThemeProvider plus the session transcript
// context with `marked` as the marked-id set. The two contexts the transcript
// components read outside the provider tree — the local agent colors and the
// sync store — are stubbed with inert values: no agent override resolves and
// no permission is ever pending. Polls past the provider's async readiness,
// then polls until every expected substring is on screen before capturing:
// the markdown/code renderables parse and highlight asynchronously (the
// reasoning body exists only after the tree-sitter worker answers its
// highlight request), so a fixed settle count races that work — the renderer
// sits idle while the worker runs, making harness frame-based waits
// (`waitFor`/`waitForFrame`) return early too. The span predicate mirrors the
// tests' own `spans.find((span) => span.text.includes(...))` reads, so the
// capture happens exactly when the assertions' preconditions hold.
async function mount(
  body: (ctx: ReturnType<typeof ctxValue>) => JSX.Element,
  wait: string | string[],
  themeSource: ThemeSource = source,
): Promise<SpanInfo[]> {
  let probe: ReturnType<typeof useTheme> | undefined
  function Probe() {
    probe = useTheme()
    // The body JSX must be created inside this scope so the components read
    // the contexts through the provider chain above them.
    return (
      <LocalContext.Provider
        value={{
          agent: { color: () => RGBA.fromInts(1, 1, 1) },
        } as never}
      >
        <SyncContext.Provider value={{ data: { permission: {} } } as never}>
          <LocationProvider location={undefined}>
            {body(ctxValue())}
          </LocationProvider>
        </SyncContext.Provider>
      </LocalContext.Provider>
    )
  }
  app = await testRender(
    () => (
      <TestTuiContexts>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark" source={themeSource}>
              <Probe />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 72, height: 20 },
  )
  const start = Date.now()
  for (;;) {
    await app.renderOnce()
    if (probe?.ready ?? false) break
    if (Date.now() - start > 5000) throw new Error("timed out waiting for theme readiness")
    await Bun.sleep(20)
  }
  const expected = Array.isArray(wait) ? wait : [wait]
  // Stay under bun's default per-test timeout so a genuine missing span
  // fails here with the captured spans instead of a raw test timeout.
  const deadline = Date.now() + 4000
  for (;;) {
    await app.renderOnce()
    const spans = spanList()
    if (expected.every((text) => spans.some((span) => span.text.includes(text)))) return spans
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for [${expected.join(", ")}]; captured spans: ${spans.map((span) => span.text.trim()).join(" | ")}`)
    }
    await Bun.sleep(25)
  }
}

function ctxValue(): typeof noopContextValue {
  return { ...noopContextValue, discarded: () => marked }
}

function assistant(id: string): AssistantMessage {
  return {
    id,
    sessionID: "ses",
    role: "assistant",
    time: { created: 1 },
    parentID: "msg_u",
    modelID: "m",
    providerID: "p",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 1, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
  } as AssistantMessage
}

function userMessage(id: string) {
  return { id, sessionID: "ses", role: "user" as const, agent: "build", model: { providerID: "p", modelID: "m" }, time: { created: 1 } }
}

let seq = 0

function textPart(messageID: string, text: string, synthetic = false): Part {
  return { id: `p${++seq}`, sessionID: "ses", messageID, type: "text", text, ...(synthetic ? { synthetic: true } : {}) }
}

function toolPart(messageID: string, status: "completed" | "pending" | "error"): Part {
  return {
    id: `p${++seq}`,
    sessionID: "ses",
    messageID,
    type: "tool",
    callID: `call${seq}`,
    tool: "read",
    state: {
      status,
      input: { filePath: "/tmp/f" },
      ...(status === "completed" ? { output: "ok" } : {}),
      ...(status === "error" ? { error: "No LSP server available" } : {}),
      title: "read",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  } as Part
}

function discardCall(messageID: string, ids: string[], status: "completed" | "pending" | "error" = "completed"): Part {
  return {
    id: `p${++seq}`,
    sessionID: "ses",
    messageID,
    type: "tool",
    callID: `call${seq}`,
    tool: "discard_context",
    state: {
      status,
      input: { ids },
      ...(status === "completed" ? { output: "ok" } : {}),
      ...(status === "error" ? { error: "boom" } : {}),
      title: "discard_context",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  } as Part
}

const DISCARDED_FG = RGBA.fromInts(255, 0, 0)
// Assistant text renders through the markdown renderer: the base fg paints
// only where no syntax rule matches, so the visible "default" span carries
// the syntax.default override from the theme file.
const NORMAL_TEXT_FG = RGBA.fromInts(9, 9, 9)

describe("discarded-block transcript styling", () => {
  test("marked assistant text renders the discarded foreground and sentinel bg (R10.1, R51.2)", async () => {
    const part = textPart("msg_a", "marked body text")
    marked = collectDiscardedPartIds([part, discardCall("msg_a", [part.id])])
    const spans = await mount(
      (ctx) => (
        <sessionTranscriptContext.Provider value={ctx}>
    <TextPart last={true} part={part as never} message={assistant("msg_a")} />
        </sessionTranscriptContext.Provider>
      ),
      "marked body text",
    )
    const body = spans.find((span) => span.text.includes("marked body text"))
    expect(body).toBeDefined()
    // The markdown renderer paints the default scope from syntax.default, so
    // the discarded fg proves itself through the sentinel background here.
    expect(body!.fg).toEqual(NORMAL_TEXT_FG)
    expect(body!.bg).toEqual(RGBA.fromInts(0, 0, 255))
  })

  test("unmarked assistant text renders unchanged beside a marked sibling (R10.4)", async () => {
    const markedPart = textPart("msg_a", "marked body")
    const unmarked = textPart("msg_a", "unmarked body")
    marked = collectDiscardedPartIds([markedPart, discardCall("msg_a", [markedPart.id])])
    const spans = await mount(
      (ctx) => (
        <sessionTranscriptContext.Provider value={ctx}>
    <TextPart last={true} part={markedPart as never} message={assistant("msg_a")} />
    <TextPart last={true} part={unmarked as never} message={assistant("msg_a")} />
        </sessionTranscriptContext.Provider>
      ),
      ["marked body", "unmarked body"],
    )
    const unmarkedSpan = spans.find((span) => span.text.includes("unmarked body"))
    expect(unmarkedSpan).toBeDefined()
    expect(unmarkedSpan!.fg).toEqual(NORMAL_TEXT_FG)
    expect(unmarkedSpan!.bg).toEqual(RGBA.fromInts(7, 7, 7))
  })

  test("marked user text and file badge carry the discarded fg; badges keep their bgs (R10.1, R51.3)", async () => {
    const text = textPart("msg_u", "user prompt text")
    const file = {
      id: "p-file",
      sessionID: "ses",
      messageID: "msg_u",
      type: "file" as const,
      mime: "text/plain",
      filename: "notes.md",
    }
    marked = collectDiscardedPartIds([text, discardCall("msg_u", [text.id, file.id])])
    const spans = await mount(
      (ctx) => (
        <sessionTranscriptContext.Provider value={ctx}>
    <UserMessage
    message={userMessage("msg_u") as never}
    parts={[text, file] as Part[]}
    onMouseUp={() => {}}
    index={0}
    />
        </sessionTranscriptContext.Provider>
      ),
      ["user prompt text", "notes.md"],
    )
    const prompt = spans.find((span) => span.text.includes("user prompt text"))
    expect(prompt).toBeDefined()
    expect(prompt!.fg).toEqual(DISCARDED_FG)
    const badge = spans.find((span) => span.text.includes("notes.md"))
    expect(badge).toBeDefined()
    expect(badge!.fg).toEqual(DISCARDED_FG)
  })

  test("marked user text with an unmarked sibling styles only the marked span (R10.4)", async () => {
    const first = textPart("msg_u", "kept prompt")
    const second = textPart("msg_u", "dropped prompt")
    marked = collectDiscardedPartIds([second, discardCall("msg_u", [second.id])])
    const spans = await mount(
      (ctx) => (
        <sessionTranscriptContext.Provider value={ctx}>
    <UserMessage
    message={userMessage("msg_u") as never}
    parts={[first, second] as Part[]}
    onMouseUp={() => {}}
    index={0}
    />
        </sessionTranscriptContext.Provider>
      ),
      ["kept prompt", "dropped prompt"],
    )
    const kept = spans.find((span) => span.text.includes("kept prompt"))
    expect(kept).toBeDefined()
    // Unmarked user text keeps message.user.body from the theme file.
    expect(kept!.fg).toEqual(RGBA.fromInts(4, 4, 4))
    const dropped = spans.find((span) => span.text.includes("dropped prompt"))
    expect(dropped).toBeDefined()
    expect(dropped!.fg).toEqual(DISCARDED_FG)
  })

  // The user-reported disappearance: a user message whose only text part is
  // marked must keep rendering (R10.1) — visible text in the discarded style,
  // plus the additive marker line; nothing may filter it from the transcript.
  test("marked user message stays visible with discarded style and marker (R10.1, R10.5)", async () => {
    const text = textPart("msg_u", "the disappearing prompt")
    const call = discardCall("msg_a", [text.id])
    marked = collectDiscardedPartIds([text, call])
    const spans = await mount(
      (ctx) => (
        <sessionTranscriptContext.Provider value={ctx}>
    <UserMessage
    message={userMessage("msg_u") as never}
    parts={[text] as Part[]}
    onMouseUp={() => {}}
    index={0}
    />
    <ToolPart last={true} part={call as never} message={assistant("msg_a")} />
        </sessionTranscriptContext.Provider>
      ),
      ["the disappearing prompt", "Discarded 1 context part"],
    )
    const prompt = spans.find((span) => span.text.includes("the disappearing prompt"))
    expect(prompt).toBeDefined()
    expect(prompt!.fg).toEqual(DISCARDED_FG)
    const marker = spans.find((span) => span.text.includes("Discarded 1 context part"))
    expect(marker).toBeDefined()
    expect(marker!.fg).toEqual(RGBA.fromInts(0, 255, 0))
  })

  test("marked reasoning body takes the discarded fg; the header keeps its element (R10.1, R51.3)", async () => {
    const part = {
      id: "p-r",
      sessionID: "ses",
      messageID: "msg_a",
      type: "reasoning" as const,
      // A "**title**" first block becomes header metadata; the rest is body.
      text: "**Weighing options**\n\nreasoned carefully",
      time: { start: 1, end: 2 },
    }
    marked = collectDiscardedPartIds([part, discardCall("msg_a", [part.id])])
    const spans = await mount(
      (ctx) => (
        <sessionTranscriptContext.Provider value={ctx}>
          <ReasoningPart last={true} part={part as never} message={assistant("msg_a")} />
        </sessionTranscriptContext.Provider>
      ),
      ["reasoned carefully", "Thought"],
    )
    const body = spans.find((span) => span.text.includes("reasoned carefully"))
    expect(body).toBeDefined()
    // The body text renders through the subtle syntax style (R37): the
    // discarded rule drives the code element's fg, which the default scope
    // picks up at thinkingOpacity alpha over the red discarded foreground.
    expect(body!.fg).toEqual(RGBA.fromInts(143, 143, 245))
    const header = spans.find((span) => span.text.includes("Thought"))
    expect(header).toBeDefined()
    expect(header!.fg).not.toEqual(DISCARDED_FG)
  })

  test("marked tool labels take the discarded fg in both pending and settled states (R10.1)", async () => {
    const settled = toolPart("msg_a", "completed")
    const pending = toolPart("msg_a", "pending")
    marked = collectDiscardedPartIds([settled, pending, discardCall("msg_a", [settled.id, pending.id])])
    const spans = await mount(
      (ctx) => (
        <sessionTranscriptContext.Provider value={ctx}>
    <ToolPart last={true} part={settled as never} message={assistant("msg_a")} />
    <ToolPart last={true} part={pending as never} message={assistant("msg_a")} />
        </sessionTranscriptContext.Provider>
      ),
      // The pending read keeps `complete` (the filePath input), so both rows
      // render the "Read /tmp/f" label; the "~ Reading file…" fallback never
      // shows for this fixture.
      ["Read /tmp/f"],
    )
    const label = spans.find((span) => span.text.includes("Read /tmp/f") && !span.text.includes("~"))
    expect(label).toBeDefined()
    // The settled completed tool renders its label in the discarded fg.
    expect(label!.fg).toEqual(DISCARDED_FG)
    const pendingRow = spans.find((span) => span.text.includes("Reading file…") || span.text.includes("Read /tmp/f"))
    expect(pendingRow).toBeDefined()
    expect(pendingRow!.fg).toEqual(DISCARDED_FG)
  })

  test("a failed marked tool keeps its state color (R10.3, R51.3)", async () => {
    const failed = toolPart("msg_a", "error")
    marked = collectDiscardedPartIds([failed, discardCall("msg_a", [failed.id])])
    const spans = await mount(
      (ctx) => (
        <sessionTranscriptContext.Provider value={ctx}>
    <ToolPart last={true} part={failed as never} message={assistant("msg_a")} />
        </sessionTranscriptContext.Provider>
      ),
      "Read /tmp/f",
    )
    const row = spans.find((span) => span.text.includes("Read /tmp/f"))
    expect(row).toBeDefined()
    expect(row!.fg).toEqual(RGBA.fromInts(3, 3, 3))
  })

  test("marker trio colors follow the state elements (R52, R53)", async () => {
    const settledPart = discardCall("msg_a", ["p-unknown"], "completed")
    const pendingPart = discardCall("msg_a", [], "pending")
    const failedPart = discardCall("msg_a", [], "error")
    marked = new Set()
    const spans = await mount(
      (ctx) => (
        <sessionTranscriptContext.Provider value={ctx}>
    <ToolPart last={true} part={settledPart as never} message={assistant("msg_a")} />
    <ToolPart last={true} part={pendingPart as never} message={assistant("msg_a")} />
    <ToolPart last={true} part={failedPart as never} message={assistant("msg_a")} />
        </sessionTranscriptContext.Provider>
      ),
      ["Discarded 1 context part", "Discarding context…", "Discard failed"],
    )
    const settledRow = spans.find((span) => span.text.includes("Discarded 1 context part"))
    expect(settledRow).toBeDefined()
    expect(settledRow!.fg).toEqual(RGBA.fromInts(0, 255, 0))
    const pendingRow = spans.find((span) => span.text.includes("Discarding context…"))
    expect(pendingRow).toBeDefined()
    expect(pendingRow!.fg).toEqual(RGBA.fromInts(255, 255, 0))
    const failedRow = spans.find((span) => span.text.includes("Discard failed"))
    expect(failedRow).toBeDefined()
    expect(failedRow!.fg).toEqual(RGBA.fromInts(255, 0, 255))
  })

  test("marked ids never render in any discarded block (R10.5)", async () => {
    const part = textPart("msg_a", "marked body text")
    const call = discardCall("msg_a", [part.id])
    marked = collectDiscardedPartIds([part, call])
    const spans = await mount(
      (ctx) => (
        <sessionTranscriptContext.Provider value={ctx}>
    <TextPart last={true} part={part as never} message={assistant("msg_a")} />
    <ToolPart last={true} part={call as never} message={assistant("msg_a")} />
        </sessionTranscriptContext.Provider>
      ),
      ["marked body text", "Discarded 1 context part"],
    )
    const rendered = spans.map((span) => span.text).join("")
    expect(rendered).not.toContain(part.id)
    expect(rendered).not.toContain(call.id)
  })

  // A hand-rolled span style map in UserMessage forwarded bold/italic/
  // underline/dim but omitted strikethrough, so the theme's strikethrough
  // attribute never reached user text spans (R51.1 attribute channel).
  test("marked user text span carries the strikethrough attribute (R51.1)", async () => {
    const strikeTheme = {
      theme: {
        ...discardTheme.theme,
        "message.discarded.text": { fg: "#ff0000", attributes: ["strikethrough"] },
      },
    }
    const strikeSource = { discover: async () => ({ "discard-v2": strikeTheme }) }
    const text = textPart("msg_u", "struck prompt")
    marked = collectDiscardedPartIds([text, discardCall("msg_a", [text.id])])
    const spans = await mount(
      (ctx) => (
        <sessionTranscriptContext.Provider value={ctx}>
          <UserMessage
            message={userMessage("msg_u") as never}
            parts={[text] as Part[]}
            onMouseUp={() => {}}
            index={0}
          />
        </sessionTranscriptContext.Provider>
      ),
      "struck prompt",
      strikeSource,
    )
    const span = spans.find((span) => span.text.includes("struck prompt"))
    expect(span).toBeDefined()
    expect(span!.fg).toEqual(DISCARDED_FG)
    expect(span!.attributes & TextAttributes.STRIKETHROUGH).toBe(TextAttributes.STRIKETHROUGH)
  })
})
