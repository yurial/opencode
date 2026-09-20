import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
// The client build: bun resolves the bare "solid-js" export to the server
// build under test conditions, and only the client build is reactive.
import { createEffect, createMemo, createRoot, createSignal } from "solid-js/dist/solid.js"
import {
  ATTRIBUTES,
  CATALOG,
  DEFAULT_THEMES,
  generateSystem,
  isElementName,
  loadTheme,
  resolveElement,
  resolveTheme,
  selectedForeground,
  tint,
  type PreparedTheme,
  type ThemeRejectionReason,
} from "../src/theme"

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

function alpha(rgba: RGBA) {
  return rgba.toInts()[3]
}

function attrs(set: ReadonlySet<string>) {
  return [...set].sort()
}

function prepare(input: unknown, mode: "dark" | "light" = "dark"): PreparedTheme {
  const result = loadTheme(input, mode)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.theme
}

function reject(input: unknown, reason: ThemeRejectionReason, mode: "dark" | "light" = "dark") {
  const result = loadTheme(input, mode)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error("expected rejection")
  expect(result.reason).toBe(reason)
  return result.message
}

test("catalog is closed and matches the spec element count", () => {
  expect(Object.keys(CATALOG).length).toBe(209)
  expect(isElementName("dialog.title")).toBe(true)
  expect(isElementName("dialog.titel")).toBe(false)
  expect(isElementName("toString")).toBe(false)
  expect(isElementName("constructor")).toBe(false)
})

test("attribute vocabulary is exactly the eight spec names", () => {
  expect(attrs(new Set(ATTRIBUTES))).toEqual([
    "blink",
    "bold",
    "dim",
    "hidden",
    "inverse",
    "italic",
    "strikethrough",
    "underline",
  ])
})

test("a v1 file without dotted keys migrates", () => {
  const prepared = prepare({ theme: { primary: "#ff0000", background: "#000000" } })
  expect(hex(prepared.theme.primary)).toBe("#ff0000")
})

test("a file with a dotted key is v2", () => {
  const prepared = prepare({ theme: { "dialog.title": { fg: "#00ff00" } } })
  expect(hex(resolveElement(prepared, "dialog.title").fg)).toBe("#00ff00")
})

test("dotted and legacy keys together are rejected as mixed", () => {
  reject(
    {
      theme: {
        text: "#ffffff",
        "dialog.title": { fg: "text" },
      },
    },
    "MIXED_FORMATS",
  )
})

test("invalid JSON is a parse error", () => {
  expect(reject("{ not json", "PARSE_ERROR")).toBeDefined()
})

test("files without a theme object are rejected", () => {
  reject("null", "NOT_A_THEME")
  reject({}, "NOT_A_THEME")
  reject({ theme: "nope" }, "NOT_A_THEME")
  reject([1, 2, 3], "NOT_A_THEME")
})

test("unknown element names are rejected", () => {
  reject(
    {
      theme: {
        "dialog.title": {},
        "dialog.titel": { fg: "#ffffff" },
      },
    },
    "UNKNOWN_ELEMENT",
  )
  reject(
    {
      theme: {
        "dialog.title": {},
        customthing: { fg: "#ffffff" },
      },
    },
    "UNKNOWN_ELEMENT",
  )
})

test("unknown attributes are rejected", () => {
  reject(
    { theme: { "dialog.title": { attributes: ["bold", "glow"] } } },
    "UNKNOWN_ATTRIBUTE",
  )
})

test("invalid colors are rejected", () => {
  reject({ theme: { "dialog.title": { fg: "#ff00f" } } }, "INVALID_COLOR")
  reject({ theme: { "dialog.title": { fg: 256 } } }, "INVALID_COLOR")
  reject({ theme: { "dialog.title": { fg: -1 } } }, "INVALID_COLOR")
  reject({ theme: { "dialog.title": { fg: 1.5 } } }, "INVALID_COLOR")
  reject({ theme: { "dialog.title": { fg: true } } }, "INVALID_COLOR")
  reject({ theme: { "dialog.title": { fg: { dark: "#111111" } } } }, "INVALID_COLOR")
  reject({ defs: { bad: "#zzzzzz" }, theme: { "dialog.title": {} } }, "INVALID_COLOR")
})

test("unresolvable references are rejected", () => {
  reject({ theme: { "dialog.title": { fg: "nosuchcolor" } } }, "UNRESOLVED_REFERENCE")
  reject({ theme: { "dialog.title": { fg: "dialog.nope" } } }, "UNRESOLVED_REFERENCE")
})

test("cyclic references are rejected", () => {
  reject(
    { defs: { one: "two", two: "one" }, theme: { "dialog.title": { fg: "one" } } },
    "CYCLIC_REFERENCE",
  )
  reject(
    {
      theme: {
        "dialog.title": { fg: "dialog.title" },
      },
    },
    "CYCLIC_REFERENCE",
  )
  reject(
    {
      theme: {
        "dialog.title": { fg: "dialog.body" },
        "dialog.body": { fg: "dialog.title" },
      },
    },
    "CYCLIC_REFERENCE",
  )
})

test("invalid entries are rejected", () => {
  reject({ theme: { "dialog.title": { color: "#ffffff" } } }, "INVALID_ENTRY")
  reject({ theme: { "dialog.title": { attributes: "bold" } } }, "INVALID_ENTRY")
  reject({ theme: { "dialog.title": "red" } }, "INVALID_ENTRY")
})

test("partial entries keep catalog defaults", () => {
  const prepared = prepare({ theme: { "dialog.title": { fg: "#ff0000" } } })
  const title = resolveElement(prepared, "dialog.title")
  expect(hex(title.fg)).toBe("#ff0000")
  expect(alpha(title.bg)).toBe(0)
  expect(attrs(title.attributes)).toEqual(["bold"])
})

test("a present attributes array replaces the default set wholesale", () => {
  const prepared = prepare({
    theme: {
      "markdown.heading.h1": { attributes: ["italic"] },
      "dialog.body": { fg: "#ffffff", attributes: [] },
    },
  })
  expect(attrs(resolveElement(prepared, "markdown.heading.h1").attributes)).toEqual(["italic"])
  expect(attrs(resolveElement(prepared, "dialog.body").attributes)).toEqual([])
})

test("dotless references resolve defs first, then the palette", () => {
  const prepared = prepare({
    defs: { ink: "#101010" },
    theme: {
      "dialog.body": { fg: "ink" },
      "dialog.muted": { fg: "text" },
    },
  })
  expect(hex(resolveElement(prepared, "dialog.body").fg)).toBe("#101010")
  expect(resolveElement(prepared, "dialog.muted").fg).toEqual(prepared.theme.text)
})

test("dotted references resolve channel-wise and never carry attributes", () => {
  const prepared = prepare({
    theme: {
      "dialog.title": { attributes: ["bold"] },
      "dialog.body": { fg: "dialog.error", bg: "dialog.panel" },
    },
  })
  const body = resolveElement(prepared, "dialog.body")
  expect(body.fg).toEqual(resolveElement(prepared, "dialog.error").fg)
  expect(body.bg).toEqual(resolveElement(prepared, "dialog.panel").bg)
  expect(attrs(body.attributes)).toEqual([])
})

test("ansi indices resolve through the fixed vga table within bounds", () => {
  const prepared = prepare({
    theme: {
      "dialog.body": { fg: 160 },
      "dialog.muted": { fg: 255 },
      "dialog.notice": { fg: 0 },
    },
  })
  expect(hex(resolveElement(prepared, "dialog.body").fg)).toBe("#d70000")
  expect(hex(resolveElement(prepared, "dialog.muted").fg)).toBe("#eeeeee")
  expect(hex(resolveElement(prepared, "dialog.notice").fg)).toBe("#000000")
})

test("dark and light variants follow the active mode", () => {
  const source = { theme: { "dialog.body": { fg: { dark: "#111111", light: "#eeeeee" } } } }
  expect(hex(resolveElement(prepare(source, "dark"), "dialog.body").fg)).toBe("#111111")
  expect(hex(resolveElement(prepare(source, "light"), "dialog.body").fg)).toBe("#eeeeee")
})

test("selected-foreground prefers an explicit palette value", () => {
  const source = structuredClone(DEFAULT_THEMES["lucent-orng"]!)
  const prepared = prepare(source)
  const flat = prepared.theme
  expect(flat._hasSelectedListItemText).toBe(true)
  expect(resolveElement(prepared, "dialog.action").fg).toEqual(flat.selectedListItemText)
  expect(resolveElement(prepared, "which-key.tab").fg).toEqual(flat.selectedListItemText)
})

test("selected-foreground falls back to luminance over a transparent background", () => {
  const source = structuredClone(DEFAULT_THEMES.opencode)
  ;(source.theme as Record<string, unknown>).background = "transparent"
  const dark = prepare(source, "dark")
  // dialog.action bg default is primary (dark orange, luminance > 0.5) -> black
  expect(resolveElement(dark, "dialog.action").fg).toEqual(RGBA.fromInts(0, 0, 0))
  const light = prepare(source, "light")
  // light primary is blue (luminance < 0.5) -> white
  expect(resolveElement(light, "dialog.action").fg).toEqual(RGBA.fromInts(255, 255, 255))
})

test("selected-foreground uses the element's own resolved background", () => {
  // A file cannot express this combination (transparent palette background is
  // a v1 concept, element overrides a v2 concept), so build the prepared form
  // directly: the same palette with a transparent background plus bg overrides.
  const flat = { ...prepare(DEFAULT_THEMES.opencode).theme, background: RGBA.fromInts(0, 0, 0, 0) }
  const prepared: PreparedTheme = {
    mode: "dark",
    theme: flat,
    entries: {
      "dialog.action": { bg: "#ffffff" },
      "dialog.retry": { bg: "#101010" },
    },
    defs: {},
  }
  expect(resolveElement(prepared, "dialog.action").fg).toEqual(RGBA.fromInts(0, 0, 0))
  expect(resolveElement(prepared, "dialog.retry").fg).toEqual(RGBA.fromInts(255, 255, 255))
  // without the override, selected-foreground evaluates against the catalog default
  const untouched: PreparedTheme = { mode: "dark", theme: flat, entries: {}, defs: {} }
  expect(resolveElement(untouched, "dialog.action").fg).toEqual(RGBA.fromInts(0, 0, 0))
})

test("selected-foreground returns the palette background when it is solid", () => {
  const prepared = prepare(DEFAULT_THEMES.opencode)
  const action = resolveElement(prepared, "dialog.action")
  expect(action.fg).toEqual(prepared.theme.background)
})

test("migrated themes keep catalog defaults aligned with the flat palette", () => {
  for (const name of ["opencode", "matrix", "gruvbox", "lucent-orng"]) {
    for (const mode of ["dark", "light"] as const) {
      const prepared = prepare(DEFAULT_THEMES[name]!, mode)
      const flat = prepared.theme
      const table: Array<[string, "fg" | "bg", string]> = [
        ["app.background", "bg", "background"],
        ["dialog.title", "fg", "text"],
        ["dialog.muted", "fg", "textMuted"],
        ["dialog.action", "bg", "primary"],
        ["dialog.error", "fg", "error"],
        ["dialog.underlay", "bg", "#00000096"],
        ["autocomplete.menu", "bg", "backgroundMenu"],
        ["autocomplete.menu.border", "fg", "border"],
        ["prompt.shell.border", "fg", "primary"],
        ["prompt.extmark.file", "fg", "warning"],
        ["prompt.extmark.agent", "fg", "secondary"],
        ["prompt.extmark.paste", "bg", "warning"],
        ["message.user.body", "bg", "backgroundPanel"],
        ["message.compaction", "fg", "borderActive"],
        ["footer.status.ok", "fg", "success"],
        ["sidebar.files.added", "fg", "diffAdded"],
        ["sidebar.files.removed", "fg", "diffRemoved"],
        ["scrollbar.thumb", "fg", "border"],
        ["scrollbar.thumb.active", "fg", "borderActive"],
        ["diff.gutter", "fg", "diffLineNumber"],
        ["diff.gutter", "bg", "diffContextBg"],
        ["diff.sign.added", "fg", "diffHighlightAdded"],
        ["diff.banner.removed", "fg", "diffRemoved"],
        ["markdown.text", "fg", "markdownText"],
        ["markdown.heading.h1", "fg", "markdownHeading"],
        ["markdown.link", "fg", "markdownLink"],
        ["markdown.link.label", "fg", "markdownLinkText"],
        ["markdown.quote", "fg", "markdownBlockQuote"],
        ["markdown.list", "fg", "markdownListItem"],
        ["markdown.code", "fg", "markdownCode"],
        ["markdown.code", "bg", "background"],
        ["syntax.comment", "fg", "syntaxComment"],
        ["syntax.keyword", "fg", "syntaxKeyword"],
        ["syntax.string", "fg", "syntaxString"],
        ["syntax.number", "fg", "syntaxNumber"],
        ["syntax.type", "fg", "syntaxType"],
        ["syntax.function", "fg", "syntaxFunction"],
        ["syntax.variable", "fg", "syntaxVariable"],
        ["syntax.operator", "fg", "syntaxOperator"],
        ["syntax.punctuation", "fg", "syntaxPunctuation"],
        ["syntax.diff.delta", "fg", "diffContext"],
        ["syntax.diff.delta", "bg", "diffContextBg"],
        ["toast.info.border", "fg", "info"],
        ["permission.option", "bg", "backgroundMenu"],
        ["question.option.picked", "fg", "success"],
        ["subagent.footer.border", "fg", "border"],
        ["which-key.subtle", "fg", "borderSubtle"],
        ["startup.loading", "fg", "textMuted"],
        ["logo.left", "fg", "textMuted"],
        ["logo.right", "fg", "text"],
        ["bg-pulse.accent", "fg", "primary"],
        ["tips.marker", "fg", "warning"],
        ["run.footer.highlight", "fg", "primary"],
        ["run.entry.reasoning", "fg", "textMuted"],
        ["run.splash.right", "fg", "text"],
        ["run.block.muted", "fg", "textMuted"],
      ]
      for (const [element, channel, paletteName] of table) {
        const resolved = resolveElement(prepared, element)
        const actual = channel === "fg" ? resolved.fg : resolved.bg
        const expected = paletteName.startsWith("#")
          ? RGBA.fromHex(paletteName)
          : (flat[paletteName as keyof typeof flat] as RGBA)
        expect(actual).toEqual(expected)
      }
      // selected-foreground elements evaluate the contrast rule against their own background
      expect(resolveElement(prepared, "prompt.extmark.paste").fg).toEqual(
        selectedForeground(flat, flat.warning),
      )
      expect(resolveElement(prepared, "dialog.select.row.selected").fg).toEqual(
        selectedForeground(flat, flat.primary),
      )
      // computed tint derivation matches the legacy blend of the logo renderer
      expect(resolveElement(prepared, "bg-pulse.base").bg).toEqual(
        tint(flat.background, flat.text, 0.62),
      )
    }
  }
})

test("menu fallback: backgroundMenu falls back to backgroundElement", () => {
  const prepared = prepare(DEFAULT_THEMES.opencode)
  expect(resolveElement(prepared, "autocomplete.menu").bg).toEqual(prepared.theme.backgroundElement)
  const lucent = prepare(DEFAULT_THEMES["lucent-orng"]!)
  expect(resolveElement(lucent, "autocomplete.menu").bg).toEqual(lucent.theme.backgroundMenu)
})

test("selectedListItemText falls back to background when unset", () => {
  const prepared = prepare(DEFAULT_THEMES.opencode)
  expect(prepared.theme._hasSelectedListItemText).toBe(false)
  expect(resolveElement(prepared, "which-key.tab").fg).toEqual(prepared.theme.background)
})

test("all built-in themes load through migration in both modes", () => {
  expect(Object.keys(DEFAULT_THEMES).length).toBe(33)
  for (const [name, source] of Object.entries(DEFAULT_THEMES)) {
    for (const mode of ["dark", "light"] as const) {
      const result = loadTheme(structuredClone(source), mode)
      if (!result.ok) throw new Error(`${name} (${mode}): ${result.reason} ${result.message}`)
      expect(result.format).toBe("v1")
      for (const element of Object.keys(CATALOG)) resolveElement(result.theme, element)
      for (const key of [
        "primary",
        "background",
        "text",
        "textMuted",
        "backgroundElement",
        "borderSubtle",
        "diffContextBg",
      ] as const) {
        expect(result.theme.theme[key]).toBeDefined()
      }
    }
  }
})

test("migration carries thinkingOpacity and defaults to 0.6", () => {
  expect(prepare(DEFAULT_THEMES.opencode).theme.thinkingOpacity).toBe(0.6)
  const withOpacity = structuredClone(DEFAULT_THEMES.opencode)
  ;(withOpacity.theme as Record<string, unknown>).thinkingOpacity = 0.9
  expect(prepare(withOpacity).theme.thinkingOpacity).toBe(0.9)
  expect(
    prepare({ theme: { "dialog.title": {}, thinkingOpacity: 0.8 } }).theme.thinkingOpacity,
  ).toBe(0.8)
  expect(
    prepare({ theme: { "dialog.title": {}, thinkingOpacity: "nope" } }).theme.thinkingOpacity,
  ).toBe(0.6)
})

test("dropped legacy keys are ignored without error", () => {
  const source = structuredClone(DEFAULT_THEMES.opencode)
  const theme = source.theme as Record<string, unknown>
  theme["diffHunkHeader"] = "#123456"
  theme["markdownCodeBlock"] = "#234567"
  const prepared = prepare(source)
  expect(resolveElement(prepared, "dialog.title").fg).toEqual(prepared.theme.text)
})

test("a minimal v1 file falls back to the default built-in palette", () => {
  const prepared = prepare({ theme: { primary: "#123456", background: "#000000" } })
  expect(hex(prepared.theme.primary)).toBe("#123456")
  // untouched palette names come from the default built-in theme
  const opencode = prepare(DEFAULT_THEMES.opencode)
  expect(prepared.theme.text).toEqual(opencode.theme.text)
  expect(prepared.theme.borderSubtle).toEqual(opencode.theme.borderSubtle)
  // elements defaulting to primary take the file's value
  expect(resolveElement(prepared, "dialog.link").fg).toEqual(prepared.theme.primary)
})

test("a native v2 file resolves against the default built-in palette", () => {
  const opencode = prepare(DEFAULT_THEMES.opencode)
  const prepared = prepare({ theme: { "dialog.title": { fg: "#ff0000" } } })
  expect(resolveElement(prepared, "app.background").bg).toEqual(opencode.theme.background)
  expect(resolveElement(prepared, "autocomplete.menu").bg).toEqual(opencode.theme.backgroundElement)
  expect(resolveElement(prepared, "dialog.title").fg).toEqual(RGBA.fromHex("#ff0000"))
})

test("the generated system theme migrates like any v1 source", () => {
  const colors = {
    palette: ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0"],
    defaultForeground: "#ffffff",
    defaultBackground: "#101010",
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
  const prepared = prepare(generateSystem(colors, "dark"))
  expect(prepared.theme._hasSelectedListItemText).toBe(true)
  for (const element of Object.keys(CATALOG)) resolveElement(prepared, element)
  expect(resolveElement(prepared, "run.entry.user").fg).toEqual(prepared.theme.primary)
})

test("resolveTheme keeps returning the flat legacy palette", () => {
  const flat = resolveTheme(DEFAULT_THEMES.opencode, "dark")
  expect(flat.background).toEqual(prepare(DEFAULT_THEMES.opencode).theme.background)
  const cyclic = structuredClone(DEFAULT_THEMES.opencode)
  cyclic.defs = { ...(cyclic.defs ?? {}), one: "two", two: "one" }
  ;(cyclic.theme as Record<string, unknown>).primary = "one"
  expect(() => resolveTheme(cyclic, "dark")).toThrow("Circular color reference")
})

test("element accessor re-evaluates on theme and mode change and throws on unknown names", async () => {
  const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))
  await createRoot(async (dispose) => {
    const [source, setSource] = createSignal<unknown>({ theme: { "dialog.body": { fg: { dark: "#111111", light: "#eeeeee" } } } })
    const [mode, setMode] = createSignal<"dark" | "light">("dark")
    const prepared = createMemo(() => {
      const result = loadTheme(source(), mode())
      if (!result.ok) throw new Error(result.message)
      return result.theme
    })
    // The context wires element() exactly like this: resolveElement(prepared(), name)
    const element = (name: string) => resolveElement(prepared(), name)
    let reads = 0
    let observed = ""
    createEffect(() => {
      observed = hex(element("dialog.body").fg)
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
    expect(() => element("dialog.nope")).toThrow()
    expect(() => element("toString")).toThrow()
    dispose()
  })
})
