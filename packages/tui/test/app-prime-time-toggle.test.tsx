/** @jsxImportSource @opentui/solid */
// Regression: app.toggle.prime_time must surface a rejected switch call as a
// toast. A server without the prime-time routes answers the SPA fallback with
// text/html (HTTP 200), the SDK client throws on that content type, and the
// keymap swallows async command errors — before the fix the toggle failed
// silently: no toast, no label change, no enforcement change.
import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createEventSource, createFetch, directory } from "./fixture/tui-sdk"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

// Collects the text of every rendered text node so tests can assert which
// rows the frame actually shows.
function frameText(node: unknown): string {
  const renderable = node as { getChildren?: () => unknown[]; plainText?: unknown }
  const children = renderable.getChildren?.() ?? []
  const own = typeof renderable.plainText === "string" ? `${renderable.plainText}\n` : ""
  return own + children.map(frameText).join("")
}

async function pollFrame(
  setup: { renderer: { root: unknown }; renderOnce: () => Promise<void> },
  fragment: string,
  timeout = 5000,
) {
  const start = Date.now()
  for (;;) {
    if (frameText(setup.renderer.root).includes(fragment)) return
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for frame text: ${fragment}\n${frameText(setup.renderer.root)}`)
    }
    await Bun.sleep(20)
    await setup.renderOnce()
  }
}

test(
  "prime-time toggle shows a toast when the server answers the SPA fallback",
  async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  // Old-server behavior: unknown routes fall through to the SPA shell with a
  // 200 + text/html response, which makes the SDK client throw.
  const fallback = () =>
    new Response("<!doctype html><html><body>opencode</body></html>", {
      headers: { "content-type": "text/html" },
    })
  const calls = createFetch((url) => {
    if (url.pathname === "/experimental/prime-time") return fallback()
    if (url.pathname === "/experimental/prime-time/switch") return fallback()
    return undefined
  })
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()

    api?.keymap.dispatchCommand("app.toggle.prime_time")
    await pollFrame(setup, "text/html")

    // The failure must not flip the state signal: reopening the palette keeps
    // the enforced wording (the onMount GET failed the same way, so the
    // initial enforced default stands).
    api?.keymap.dispatchCommand("command.palette.show")
    await pollFrame(setup, "Disable prime-time limitations")

    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
  },
  30000,
)
