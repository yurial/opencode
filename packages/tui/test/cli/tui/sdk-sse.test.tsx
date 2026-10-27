/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2"
import { onMount } from "solid-js"
import { useEvent } from "../../../src/context/event"
import { captureLifecycleLog, type LifecycleRecord } from "../../fixture/lifecycle-log"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 4000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function vcs(branch: string): GlobalEvent {
  const payload: Event = {
    id: `evt_${branch}`,
    type: "vcs.branch.updated",
    properties: { branch },
  }
  return { directory, payload }
}

let SDKProvider!: (typeof import("../../../src/context/sdk"))["SDKProvider"]

function Probe(props: { handlers: Array<(event: Event) => void>; seen: Event[] }) {
  const event = useEvent()
  onMount(() => {
    event.subscribe((evt) => props.seen.push(evt))
    for (const handler of props.handlers) event.subscribe(handler)
  })
  return <box />
}

async function mount(input: { url?: string; handlers?: Array<(event: Event) => void> }) {
  const events = createEventSource()
  const calls = createFetch(undefined, events)
  const seen: Event[] = []
  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url={input.url ?? "http://test"} directory={directory} fetch={calls.fetch}>
        <Probe handlers={input.handlers ?? []} seen={seen} />
      </SDKProvider>
    </TestTuiContexts>
  ))
  return { app, events, seen }
}

const connects = (records: LifecycleRecord[], attempt: number) =>
  records.filter((record) => record.message === "event stream connect" && record.fields.attempt === String(attempt))

describe("SDK event stream lifecycle", () => {
  test("logs the subscription attempt and the clean end of the stream", async () => {
    const lifecycle = captureLifecycleLog()
    try {
      ;({ SDKProvider } = await import("../../../src/context/sdk"))
      const { app, events } = await mount({})
      try {
        await wait(() => connects(lifecycle.records(), 0).length === 1)
        expect(connects(lifecycle.records(), 0)).toEqual([
          { level: "info", message: "event stream connect", fields: expect.objectContaining({ attempt: "0" }) },
        ])

        await wait(() => events.streamReady())
        events.closeStream()
        await wait(() => lifecycle.records().some((record) => record.message === "event stream ended"))
        expect(lifecycle.records()).toContainEqual({
          level: "info",
          message: "event stream ended",
          fields: expect.objectContaining({ attempt: "0", cause: "eof" }),
        })
        expect(lifecycle.records().some((record) => record.level === "error")).toBe(false)
      } finally {
        app.renderer.destroy()
      }
    } finally {
      lifecycle.dispose()
    }
  })

  test("logs a stream error at error level and reconnects with backoff", async () => {
    const lifecycle = captureLifecycleLog()
    try {
      ;({ SDKProvider } = await import("../../../src/context/sdk"))
      const { app, events } = await mount({})
      try {
        await wait(() => connects(lifecycle.records(), 0).length === 1)
        await wait(() => events.streamReady())
        events.errorStream(new Error("sse dropped"))

        await wait(() => lifecycle.records().some((record) => record.message === "event stream error"))
        expect(lifecycle.records()).toContainEqual({
          level: "error",
          message: "event stream error",
          fields: expect.objectContaining({ attempt: "0", error: "sse dropped" }),
        })

        // The loop survives the error and reconnects after the 1s retryDelay.
        await wait(() => connects(lifecycle.records(), 1).length === 1, 6000)
        expect(connects(lifecycle.records(), 1)).toEqual([
          {
            level: "info",
            message: "event stream connect",
            fields: expect.objectContaining({ attempt: "1", backoff_ms: "1000" }),
          },
        ])
      } finally {
        app.renderer.destroy()
      }
    } finally {
      lifecycle.dispose()
    }
  })

  test("a throwing handler is logged and later events still reach other handlers", async () => {
    const lifecycle = captureLifecycleLog()
    try {
      ;({ SDKProvider } = await import("../../../src/context/sdk"))
      const { app, events, seen } = await mount({
        handlers: [
          () => {
            throw new Error("handler exploded")
          },
        ],
      })
      try {
        await wait(() => connects(lifecycle.records(), 0).length === 1)
        events.feed(vcs("one"))
        await wait(() => seen.length === 1)

        expect(seen).toHaveLength(1)
        expect(lifecycle.records()).toContainEqual({
          level: "error",
          message: "event handler failed",
          fields: expect.objectContaining({ event: "vcs.branch.updated", error: "handler exploded" }),
        })

        // The subscription survives the handler exception (R15.6).
        events.feed(vcs("two"))
        await wait(() => seen.length === 2)
        expect(seen).toHaveLength(2)
      } finally {
        app.renderer.destroy()
      }
    } finally {
      lifecycle.dispose()
    }
  })

  test("even an unloggable stream error is recorded, never silent", async () => {
    const lifecycle = captureLifecycleLog()
    try {
      ;({ SDKProvider } = await import("../../../src/context/sdk"))
      const { app, events } = await mount({})
      try {
        await wait(() => connects(lifecycle.records(), 0).length === 1)
        await wait(() => events.streamReady())
        // An error value whose stringification throws defeats the
        // classification record itself; the last-resort handler must still
        // write a record instead of dying silently.
        events.errorStream({
          [Symbol.toPrimitive]() {
            throw new Error("meta boom")
          },
        })

        await wait(() => lifecycle.records().some((record) => record.message === "event stream error"))
        expect(lifecycle.records()).toContainEqual({
          level: "error",
          message: "event stream error",
          fields: expect.objectContaining({ error: "meta boom" }),
        })
      } finally {
        app.renderer.destroy()
      }
    } finally {
      lifecycle.dispose()
    }
  })
})
