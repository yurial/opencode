import { expect, test } from "bun:test"
import { SyntaxStyle, type RGBA } from "@opentui/core"
import { createBindingLookup } from "@opentui/keymap/extras"
// The client build: bun resolves the bare "solid-js" export to the server
// build under test conditions, and only the client build is reactive.
import { createEffect, createMemo, createRoot, createSignal } from "solid-js/dist/solid.js"
import { createTuiApi } from "../../src/plugin/api"
import { createTuiApiAdapters } from "../../src/plugin/adapters"
import {
  DEFAULT_THEMES,
  allThemes,
  hasTheme,
  loadTheme,
  resolveElement,
  resolveTheme,
  type ResolvedElement,
} from "../../src/theme"
import type { TuiPluginApi, TuiThemeElement } from "@opencode-ai/plugin/tui"

type AdapterInput = Parameters<typeof createTuiApiAdapters>[0]
type ContextTheme = AdapterInput["theme"]

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

// Wires the theme context exactly like context/theme.tsx: a prepared-theme
// memo, the flat view behind a forwarding proxy, and element(name) resolving
// through resolveElement(prepared(), name).
function contextTheme(source: () => unknown, mode: () => "dark" | "light"): ContextTheme {
  const prepared = createMemo(() => {
    const result = loadTheme(source(), mode())
    if (!result.ok) throw new Error(result.message)
    return result.theme
  })
  const values = () => prepared().theme
  return {
    theme: new Proxy(values(), {
      get(_target, prop) {
        // @ts-expect-error Properties are forwarded to the current reactive value.
        return values()[prop]
      },
    }),
    element: (name: string) => resolveElement(prepared(), name),
    get selected() {
      return "test"
    },
    all: allThemes,
    has: hasTheme,
    syntax: () => SyntaxStyle.create(),
    subtleSyntax: () => SyntaxStyle.create(),
    mode,
    locked: () => false,
    lock: () => {},
    unlock: () => {},
    setMode: () => {},
    set: () => false,
    get ready() {
      return true
    },
  }
}

// The theme branch is the only exercised path. The other inputs are inert
// stubs, except the ones createTuiApi's spread evaluates eagerly (version,
// route.current, kv.ready, client, tuiConfig, theme). Assembled like app.tsx.
function pluginApi(theme: ContextTheme): TuiPluginApi {
  const input = {
    version: "test",
    theme,
    route: { data: { type: "home" } },
    kv: { ready: true },
    sdk: { client: {} },
    tuiConfig: { keybinds: createBindingLookup({}) },
    dialog: {},
  } as unknown as AdapterInput
  return createTuiApi(createTuiApiAdapters(input))
}

test("theme.element resolves catalog elements through the plugin API and throws outside it", () => {
  createRoot((dispose) => {
    const api = pluginApi(contextTheme(() => DEFAULT_THEMES.opencode, () => "dark"))
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
    dispose()
  })
})

test("the plugin element result is the shared resolved-element shape", () => {
  createRoot((dispose) => {
    const api = pluginApi(contextTheme(() => DEFAULT_THEMES.opencode, () => "dark"))
    // Both directions of the structural contract.
    const resolved: ResolvedElement = api.theme.element("dialog.title")
    const mirrored: TuiThemeElement = resolved
    expect(mirrored.attributes.has("bold")).toBe(true)
    dispose()
  })
})

test("theme.current keeps exposing the flat legacy projection", () => {
  const api = pluginApi(contextTheme(() => DEFAULT_THEMES.opencode, () => "dark"))
  const flat = resolveTheme(DEFAULT_THEMES.opencode, "dark")
  expect(hex(api.theme.current.background)).toBe(hex(flat.background))
  expect(hex(api.theme.current.text)).toBe(hex(flat.text))
  expect(api.theme.current.thinkingOpacity).toBe(flat.thinkingOpacity)
})

test("reads through theme.element re-evaluate on theme and mode change", async () => {
  const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))
  await createRoot(async (dispose) => {
    const [source, setSource] = createSignal<unknown>({ theme: { "dialog.body": { fg: { dark: "#111111", light: "#eeeeee" } } } })
    const [mode, setMode] = createSignal<"dark" | "light">("dark")
    const api = pluginApi(contextTheme(source, mode))
    let reads = 0
    let observed = ""
    createEffect(() => {
      observed = hex(api.theme.element("dialog.body").fg)
      reads++
    })
    await tick()
    expect(observed).toBe("#111111")
    setMode("light")
    await tick()
    expect(observed).toBe("#eeeeee")
    setSource({ theme: { "dialog.body": { fg: "#0000ff" } } })
    await tick()
    expect(observed).toBe("#0000ff")
    expect(reads).toBe(3)
    dispose()
  })
})
