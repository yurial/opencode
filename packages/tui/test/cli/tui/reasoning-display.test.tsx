/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import type { AssistantMessage, MetaPart, ReasoningPart, TextPart } from "@opencode-ai/sdk/v2"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { MetaPartLine, ReasoningHeader } from "../../../src/routes/session"
import { formatMessage, formatPart, type TranscriptOptions } from "../../../src/util/transcript"

let app: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  app?.renderer.destroy()
  app = undefined
})

const config = createTuiResolvedConfig()

function Harness(props: { children: JSX.Element }) {
  return (
    <TestTuiContexts>
      <TuiConfigProvider config={config}>
        <KVProvider>
          <ThemeProvider mode="dark">{props.children}</ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  )
}

// Providers gate children on async readiness (KV file read, theme discovery),
// so poll rendered frames instead of trusting the first render pass.
async function renderFrame(
  component: () => JSX.Element,
  expected: string | RegExp,
  timeout = 5000,
): Promise<string> {
  app = await testRender(
    () => (
      <Harness>
        <box flexDirection="column" width={72}>
          {component()}
        </box>
      </Harness>
    ),
    { width: 72, height: 5 },
  )
  const start = Date.now()
  for (;;) {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    if (typeof expected === "string" ? frame.includes(expected) : expected.test(frame)) return frame
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${expected} in:\n${frame}`)
    await Bun.sleep(20)
  }
}

function frameLines(frame: string) {
  return frame
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

function message(): AssistantMessage {
  return {
    id: "msg-1",
    sessionID: "ses-1",
    role: "assistant",
    time: { created: 1000 },
    parentID: "msg-0",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp/opencode", root: "/tmp/opencode" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function meta(kind: string, payload: Record<string, unknown>): MetaPart {
  return { id: "prt-2", sessionID: "ses-1", messageID: "msg-1", type: "meta", kind, payload }
}

const options: TranscriptOptions = { thinking: true, toolDetails: true, assistantMetadata: true }

describe("reasoning timer", () => {
  test("finalized empty part renders a fixed mm:ss timer line and no body", async () => {
    const frame = await renderFrame(
      () => (
        <ReasoningHeader
          toggleable={false}
          open={true}
          done={true}
          title={null}
          empty={true}
          start={100000}
          end={165000}
        />
      ),
      "Reasoning: 1m 5s",
    )
    expect(frameLines(frame)).not.toContain("Thought")
    expect(frameLines(frame)).not.toContain("Thinking")
  })

  test("finalized empty part renders the same fixed duration on re-render", async () => {
    await renderFrame(
      () => (
        <ReasoningHeader
          toggleable={false}
          open={true}
          done={true}
          title={null}
          empty={true}
          start={100000}
          end={165000}
        />
      ),
      "Reasoning: 1m 5s",
    )
    await Bun.sleep(1300)
    await app!.renderOnce()
    expect(frameLines(app!.captureCharFrame())).toContain("Reasoning: 1m 5s")
  })

  test("empty part header ticks live while not finalized", async () => {
    await renderFrame(
      () => (
        <ReasoningHeader
          toggleable={false}
          open={true}
          done={false}
          title={null}
          empty={true}
          start={Date.now() - 65500}
        />
      ),
      "Reasoning: 1m 5s",
    )
    expect(frameLines(app!.captureCharFrame())).not.toContain("Thinking")
    // The live timer must cross the minute-second boundary on its own.
    await Bun.sleep(1200)
    const start = Date.now()
    let label: string | undefined
    while (Date.now() - start < 4000) {
      await app!.renderOnce()
      label = app!.captureCharFrame().match(/Reasoning: [^\n]+/)?.[0].trim()
      if (label === "Reasoning: 1m 6s") break
      await Bun.sleep(20)
    }
    expect(label).toBe("Reasoning: 1m 6s")
  }, 15000)

  test("negative elapsed renders as zero on a finalized empty part", async () => {
    const frame = await renderFrame(
      () => (
        <ReasoningHeader
          toggleable={false}
          open={true}
          done={true}
          title={null}
          empty={true}
          start={200000}
          end={100000}
        />
      ),
      "Reasoning: 0ms",
    )
    expect(frame).toBeDefined()
  })

  test("finalized non-empty part keeps the Thought header with elapsed suffix", async () => {
    const frame = await renderFrame(
      () => (
        <ReasoningHeader
          toggleable={false}
          open={true}
          done={true}
          title={null}
          empty={false}
          start={100000}
          end={165000}
        />
      ),
      "Thought · 1m 5s",
    )
    expect(frame).toBeDefined()
  })

  test("finalized non-empty part keeps a summary title before the elapsed suffix", async () => {
    const frame = await renderFrame(
      () => (
        <ReasoningHeader
          toggleable={false}
          open={true}
          done={true}
          title="Deep dive"
          empty={false}
          start={100000}
          end={165000}
        />
      ),
      "Thought: Deep dive · 1m 5s",
    )
    expect(frame).toBeDefined()
  })

  test("non-empty in-progress part keeps the bare Thinking spinner without duration", async () => {
    const frame = await renderFrame(
      () => (
        <ReasoningHeader
          toggleable={false}
          open={true}
          done={false}
          title={null}
          empty={false}
          start={Date.now() - 65500}
        />
      ),
      "Thinking",
    )
    expect(frameLines(frame)).not.toContain("Reasoning")
    expect(frameLines(frame)).not.toMatch(/\d/)
  })
})

describe("meta part lines", () => {
  test("renders a retry attempt line from the payload", async () => {
    const frame = await renderFrame(
      () => (
        <MetaPartLine
          last={false}
          part={meta("stream-retry", { attempt: 2, error: "Provider is overloaded" })}
          message={message()}
        />
      ),
      "Retry 2: Provider is overloaded",
    )
    expect(frame).toBeDefined()
  })

  test("renders a terminal stream error line from the payload", async () => {
    const frame = await renderFrame(
      () => <MetaPartLine last={false} part={meta("stream-error", { error: "no_kv_space" })} message={message()} />,
      "Stream error: no_kv_space",
    )
    expect(frame).toBeDefined()
  })

  test("renders unknown kinds as a muted line that cannot crash the transcript", async () => {
    const frame = await renderFrame(
      () => <MetaPartLine last={false} part={meta("quota", { detail: "ignored" })} message={message()} />,
      "quota",
    )
    expect(frame).toBeDefined()
  })

  test("meta parts never reach the copied or exported transcript", () => {
    const part = meta("stream-error", { error: "secret failure detail" })
    expect(formatPart(part, options)).toBe("")
    const text: TextPart = {
      id: "prt-3",
      sessionID: "ses-1",
      messageID: "msg-1",
      type: "text",
      text: "visible answer",
    }
    const out = formatMessage(message(), [part, text], options)
    expect(out).toContain("visible answer")
    expect(out).not.toContain("secret failure detail")
    expect(out).not.toContain("Stream error")
  })

  test("repeated identical failures each render their own line", async () => {
    const frame = await renderFrame(
      () => (
        <box flexDirection="column">
          <MetaPartLine last={false} part={meta("stream-retry", { attempt: 1, error: "overloaded" })} message={message()} />
          <MetaPartLine last={false} part={meta("stream-retry", { attempt: 2, error: "overloaded" })} message={message()} />
        </box>
      ),
      "Retry 2: overloaded",
    )
    expect(frame).toContain("Retry 1: overloaded")
  })
})
