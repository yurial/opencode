/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createBindingLookup } from "@opentui/keymap/extras"
import { testRender } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
// The @opentui/solid preload remaps the bare "solid-js" export onto the
// reactive client build, so effects created here track the provider's
// signals; importing "solid-js/dist/solid.js" directly would create a second
// solid instance and silently never re-run.
import { createEffect } from "solid-js"
import path from "node:path"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider, useTheme } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { createTuiApi } from "../../src/plugin/api"
import { createTuiApiAdapters } from "../../src/plugin/adapters"
import {
  DEFAULT_THEMES,
  loadTheme,
  resolveElement,
  resolveTheme,
  type ResolvedElement,
} from "../../src/theme"
import type { TuiPluginApi, TuiThemeElement } from "@opencode-ai/plugin/tui"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

type AdapterInput = Parameters<typeof createTuiApiAdapters>[0]

function hex(rgba: RGBA) {
  return (
    "#" +
    rgba
      .toInts()
      .slice(0, 3)
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")
  )
}

const config = createTuiResolvedConfig()

// Unique KV state per mount: the provider persists the mode lock there and the
// tests must not leak a lock across mounts or parallel bun processes.
function stateDir() {
  return path.join("/tmp/opencode", "tui-plugin-theme-test", crypto.randomUUID())
}

type Mounted = {
  api: TuiPluginApi
  theme: ReturnType<typeof useTheme>
  destroy: () => void
}

// Mounts the real ThemeProvider and builds the plugin API from the live
// `useTheme()` context through the real adapter chain. The other adapter
// inputs are inert stubs, except the ones createTuiApi's spread evaluates
// eagerly (version, route.current, kv.ready, client, tuiConfig) — assembled
// like app.tsx.
async function mountPluginApi(): Promise<Mounted> {
  let mounted: { api: TuiPluginApi; theme: ReturnType<typeof useTheme> } | undefined
  function Capture() {
    const theme = useTheme()
    const api = createTuiApi(
      createTuiApiAdapters({
        version: "test",
        theme,
        route: { data: { type: "home" } },
        kv: { ready: true },
        sdk: { client: {} },
        tuiConfig: { keybinds: createBindingLookup({}) },
        dialog: {},
      } as unknown as AdapterInput),
    )
    mounted = { api, theme }
    return <box />
  }
  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: stateDir() }}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <Capture />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 20, height: 4 },
  )
  // The provider gates children on readiness (theme discovery), so Capture
  // runs only after the async mount settles.
  await pollUntil(() => !!mounted && mounted.theme.ready)
  return {
    api: mounted!.api,
    theme: mounted!.theme,
    destroy: () => app.renderer.destroy(),
  }
}

async function pollUntil(predicate: () => boolean, timeout = 5000) {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeout) throw new Error("timed out waiting for theme propagation")
    await Bun.sleep(20)
  }
}

test("theme.element resolves catalog elements through the plugin API and throws outside it", async () => {
  const { api, theme, destroy } = await mountPluginApi()
  try {
    await pollUntil(() => theme.ready)
    const result = loadTheme(DEFAULT_THEMES.opencode, "dark")
    if (!result.ok) throw new Error(result.message)

    const resolved = api.theme.element("dialog.select.row.selected")
    expect(resolved).toEqual(resolveElement(result.theme, "dialog.select.row.selected"))

    // Channels agree with the flat projection and the catalog defaults.
    expect(hex(api.theme.element("app.background").bg)).toBe(hex(api.theme.current.background))
    expect(hex(api.theme.element("dialog.title").fg)).toBe(hex(api.theme.current.text))
    expect(api.theme.element("dialog.title").attributes.has("bold")).toBe(true)
    expect(api.theme.element("app.background").attributes.size).toBe(0)

    // Non-catalog names throw (R43), including proxy escape hatches.
    expect(() => api.theme.element("dialog.nope")).toThrow()
    expect(() => api.theme.element("toString")).toThrow()
  } finally {
    destroy()
  }
})

test("the plugin element result is the shared resolved-element shape", async () => {
  const { api, theme, destroy } = await mountPluginApi()
  try {
    await pollUntil(() => theme.ready)
    // Both directions of the structural contract.
    const resolved: ResolvedElement = api.theme.element("dialog.title")
    const mirrored: TuiThemeElement = resolved
    expect(mirrored.attributes.has("bold")).toBe(true)
  } finally {
    destroy()
  }
})

test("theme.current keeps exposing the flat legacy projection", async () => {
  const { api, theme, destroy } = await mountPluginApi()
  try {
    await pollUntil(() => theme.ready)
    const flat = resolveTheme(DEFAULT_THEMES.opencode, "dark")
    expect(hex(api.theme.current.background)).toBe(hex(flat.background))
    expect(hex(api.theme.current.text)).toBe(hex(flat.text))
    expect(api.theme.current.thinkingOpacity).toBe(flat.thinkingOpacity)
  } finally {
    destroy()
  }
})

test("reads through theme.element re-evaluate on theme and mode change", async () => {
  const { api, theme, destroy } = await mountPluginApi()
  try {
    await pollUntil(() => theme.ready)
    let reads = 0
    let observed = ""
    createEffect(() => {
      observed = hex(api.theme.element("dialog.body").fg)
      reads++
    })
    const mode0 = theme.mode()
    const initial = loadTheme(DEFAULT_THEMES.opencode, mode0)
    if (!initial.ok) throw new Error(initial.message)
    expect(observed).toBe(hex(resolveElement(initial.theme, "dialog.body").fg))

    const flipped = mode0 === "dark" ? "light" : "dark"
    theme.setMode(flipped)
    const modeHex = (() => {
      const result = loadTheme(DEFAULT_THEMES.opencode, flipped)
      if (!result.ok) throw new Error(result.message)
      return hex(resolveElement(result.theme, "dialog.body").fg)
    })()
    await pollUntil(() => observed === modeHex)

    expect(theme.set("matrix")).toBe(true)
    const themeHex = (() => {
      const result = loadTheme(DEFAULT_THEMES.matrix, flipped)
      if (!result.ok) throw new Error(result.message)
      return hex(resolveElement(result.theme, "dialog.body").fg)
    })()
    await pollUntil(() => observed === themeHex)
    expect(reads).toBe(3)
  } finally {
    theme.unlock()
    theme.set("opencode")
    destroy()
  }
})
