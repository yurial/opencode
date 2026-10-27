import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { TuiSlotView } from "./tui-plugin"

// A mounted slot frame: the live testRender app behind a minimal harness.
// render() pumps the reactive loop around a 25ms settle, frame() captures
// the current char frame, dispose() releases resources the plugin registered
// at activation, destroy() releases the renderer.
export type TuiSlotHarness = {
  frame: () => string
  render: () => Promise<void>
  dispose: () => void
  destroy: () => void
}

// Flat span list of a captured frame: text plus resolved fg/bg/attributes,
// for color-level assertions the char frame cannot carry. Blank spans drop.
export type TuiSlotSpan = { text: string; fg: RGBA; bg: RGBA; attributes: number }

const settleMs = 25
const captureAttempts = 5

async function pump(app: Awaited<ReturnType<typeof testRender>>) {
  await app.renderOnce()
  await new Promise((resolve) => setTimeout(resolve, settleMs))
  await app.renderOnce()
}

function spanList(app: Awaited<ReturnType<typeof testRender>>): TuiSlotSpan[] {
  const spans: TuiSlotSpan[] = []
  for (const line of app.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.trim().length > 0) {
        spans.push({ text: span.text, fg: span.fg, bg: span.bg, attributes: span.attributes })
      }
    }
  }
  return spans
}

// Mounts a plugin slot renderer into a testRender frame the way the host
// mounts a sidebar block (packages/opencode/src/plugin/tui/runtime.ts): the
// view receives a `{theme}` context and the `session_id` prop. The session
// id arrives as a getter so tests can fire refetch triggers without
// remounting.
async function mount(input: { slot: TuiSlotView; sessionID: () => string; width: number; height: number }) {
  const app = await testRender(
    () => input.slot({ theme: undefined }, { get session_id() { return input.sessionID() } }),
    { width: input.width, height: input.height },
  )
  await pump(app)
  return app
}

export async function mountTuiSlot(input: {
  slot: TuiSlotView
  sessionID: () => string
  width: number
  height: number
  dispose?: () => void
}): Promise<TuiSlotHarness> {
  const app = await mount(input)
  return {
    frame: () => app.captureCharFrame(),
    render: () => pump(app),
    dispose: () => input.dispose?.(),
    destroy: () => app.renderer.destroy(),
  }
}

// One-shot render: mount the slot, stabilize the char frame — render and
// capture repeatedly until the frame is non-blank, since an unrendered char
// frame is uninitialized memory, not a blank screen — then return the frame
// with its span list and destroy the app.
export async function renderTuiSlot(input: {
  slot: TuiSlotView
  sessionID: () => string
  width: number
  height: number
}): Promise<{ frame: string; spans: TuiSlotSpan[] }> {
  const app = await mount(input)
  try {
    for (let attempt = 0; attempt < captureAttempts; attempt++) {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      if (frame.trim().length > 0) return { frame, spans: spanList(app) }
      await new Promise((resolve) => setTimeout(resolve, settleMs))
    }
    return { frame: app.captureCharFrame(), spans: spanList(app) }
  } finally {
    app.renderer.destroy()
  }
}
