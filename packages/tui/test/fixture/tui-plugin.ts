import type { TuiPlugin, TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"
import type { JSX } from "solid-js"
import { RGBA } from "@opentui/core"
import { createTuiResolvedConfig } from "./tui-runtime"

type Opts = {
  client?: TuiPluginApi["client"]
  keymap?: TuiPluginApi["keymap"]
  attention?: Partial<TuiPluginApi["attention"]>
  event?: TuiPluginApi["event"]
  state?: { session?: Partial<TuiPluginApi["state"]["session"]> }
  // Per-element resolved colors: `element(name)` returns the entry for the
  // name, falling back to the shared default color. Lets a test observe
  // which element a widget reads.
  theme?: { elements?: Record<string, { fg: RGBA; bg: RGBA; attributes: ReadonlySet<string> }> }
}

export function createTuiPluginApi(opts: Opts = {}) {
  const values = new Map<string, unknown>()
  const color = RGBA.fromInts(200, 200, 200)
  const dialog = { clear() {}, replace() {}, setSize() {}, size: "medium" as const, depth: 0, open: false }
  const elements = opts.theme?.elements
  return {
    attention: { notify: async () => ({ ok: false, notification: false, sound: false }), ...opts.attention },
    client: opts.client,
    event: opts.event,
    keymap: opts.keymap,
    kv: {
      get(name: string, fallback?: unknown) {
        return values.has(name) ? values.get(name) : fallback
      },
      set(name: string, value: unknown) {
        values.set(name, value)
      },
      ready: true,
    },
    state: { session: { get: () => undefined, ...opts.state?.session } },
    theme: {
      current: new Proxy({}, { get: () => color }),
      element: (name: string) =>
        elements?.[name] ?? { fg: color, bg: color, attributes: new Set<string>() },
    },
    tuiConfig: createTuiResolvedConfig(),
    ui: { dialog },
  } as unknown as TuiPluginApi
}

// The slot renderer a sidebar plugin registers: the host invokes it with the
// render context and the slot props.
export type TuiSlotView = (ctx: unknown, props: { session_id: string }) => JSX.Element

type TuiSlotRegistration = { order?: number; slots: Record<string, unknown> }

// Activates a TUI plugin against a captured slots.register, mirroring the
// host flow in packages/opencode/src/plugin/tui/runtime.ts: the host passes
// its registry-backed slots api and owns the returned registration id, so
// the fixture stub fixes one the same way. Returns the whole registration
// for order/slot-shape assertions plus the captured sidebar_content renderer
// for mounting through test/fixture/tui-frame.
export async function activateTuiPluginSlot(
  plugin: { tui: TuiPlugin },
  opts: {
    meta: TuiPluginMeta
    options?: Record<string, unknown>
    client?: unknown
    state?: {
      session?: Partial<TuiPluginApi["state"]["session"]>
      part?: TuiPluginApi["state"]["part"]
    }
    lifecycle?: TuiPluginApi["lifecycle"]
    theme?: Opts["theme"]
  },
) {
  let registered: TuiSlotRegistration | undefined
  let sidebar: TuiSlotView | undefined
  const base = createTuiPluginApi({ theme: opts.theme })
  const api = {
    ...base,
    client: opts.client,
    state: {
      ...base.state,
      ...opts.state,
      session: { ...base.state.session, ...opts.state?.session },
    },
    ...(opts.lifecycle ? { lifecycle: opts.lifecycle } : {}),
    slots: {
      register(next: TuiSlotRegistration) {
        registered = next
        sidebar = next.slots.sidebar_content as TuiSlotView
        return "internal:test-plugin"
      },
    },
  } as unknown as TuiPluginApi

  await plugin.tui(api, opts.options, opts.meta)
  const view = sidebar
  if (!view) throw new Error("sidebar_content slot was not registered")
  return { registered, sidebar: view }
}
