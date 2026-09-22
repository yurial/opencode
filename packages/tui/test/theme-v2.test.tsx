/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA, TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
// The @opentui/solid preload remaps the bare "solid-js" export onto the
// reactive client build, so effects created here track the provider's
// signals; importing "solid-js/dist/solid.js" directly would create a second
// solid instance and silently never re-run.
import { createEffect } from "solid-js"
import { KVProvider } from "../src/context/kv"
import { ThemeProvider, useTheme } from "../src/context/theme"
import { TuiConfigProvider } from "../src/config"
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
import { textAttributes } from "../src/theme/catalog"
import { LEGACY_COLOR_KEYS, type ThemeColor } from "../src/theme/types"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import path from "node:path"

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
  expect(Object.keys(CATALOG).length).toBe(280)
  expect(isElementName("dialog.title")).toBe(true)
  expect(isElementName("dialog.titel")).toBe(false)
  expect(isElementName("toString")).toBe(false)
  expect(isElementName("constructor")).toBe(false)
})

test("catalog discarded-block rows match the spec (R51, R54)", () => {
  const palette = (name: string) => ({ source: "palette", name }) as const
  // discarded-alpha (Configuration): the dimmed-palette multiplier.
  const discardedAlpha = 0x96 / 255
  expect(CATALOG["message.discarded.text"]).toEqual({
    fg: { source: "dimmed-palette", name: "textMuted", alpha: discardedAlpha },
  })
  expect(CATALOG["message.discarded.marker"]).toEqual({ fg: palette("textMuted") })
  expect(CATALOG["message.discarded.pending"]).toEqual({ fg: palette("text") })
  expect(CATALOG["message.discarded.error"]).toEqual({ fg: palette("error") })
  expect(CATALOG["sidebar.discard.header"]).toEqual({ fg: palette("text"), attributes: ["bold"] })
  expect(CATALOG["sidebar.discard.row"]).toEqual({ fg: palette("textMuted") })
  // Zone placement follows the spec tables: the discarded rows sit in the
  // message zone after the tool rows, the discard sidebar rows before the
  // getting-started row.
  const keys = Object.keys(CATALOG)
  expect(keys.indexOf("message.discarded.text")).toBe(keys.indexOf("message.tool.args.denied") + 1)
  expect(keys.indexOf("message.error.panel")).toBe(keys.indexOf("message.discarded.error") + 1)
  expect(keys.indexOf("sidebar.discard.header")).toBe(keys.indexOf("sidebar.todo.pending") + 1)
  expect(keys.indexOf("sidebar.getting-started")).toBe(keys.indexOf("sidebar.discard.row") + 1)
})

test("dimmed-palette resolves the palette color with its alpha multiplied (R34, R51.1)", () => {
  const prepared = prepare(DEFAULT_THEMES.opencode)
  const flat = prepared.theme
  const discarded = resolveElement(prepared, "message.discarded.text")
  // Same RGB as the plain palette textMuted, alpha scaled by 0x96/255.
  expect(hex(discarded.fg)).toBe(hex(flat.textMuted))
  expect(discarded.fg.toInts()).toEqual([flat.textMuted.toInts()[0], flat.textMuted.toInts()[1], flat.textMuted.toInts()[2], 0x96])
  expect(discarded.bg).toEqual(RGBA.fromInts(0, 0, 0, 0))
  expect(attrs(discarded.attributes)).toEqual([])
})

test("dimmed-palette with alpha 1 equals the plain palette color", () => {
  const base = prepare(DEFAULT_THEMES.opencode)
  // A v2 file cannot express a bare ColorDefault channel, so exercise the
  // alpha-1 equivalence through the internal prepared form: the same palette
  // with an alpha-1 dimmed default is the plain palette color. The entry
  // values are typed loosely — the prepared form is an internal shape.
  const entries = {
    "message.discarded.text": { fg: { source: "dimmed-palette", name: "textMuted", alpha: 1 } },
  } as unknown as PreparedTheme["entries"]
  const prepared: PreparedTheme = { mode: "dark", theme: base.theme, entries, defs: {} }
  expect(resolveElement(prepared, "message.discarded.text").fg).toEqual(base.theme.textMuted)
  // A non-1 scalar multiplies: a custom entry halves the alpha.
  const halfEntries = {
    "message.discarded.text": { fg: { source: "dimmed-palette", name: "textMuted", alpha: 0.5 } },
  } as unknown as PreparedTheme["entries"]
  const half: PreparedTheme = { mode: "dark", theme: base.theme, entries: halfEntries, defs: {} }
  const halved = resolveElement(half, "message.discarded.text").fg
  const [r, g, b] = base.theme.textMuted.toInts()
  expect(halved.toInts()).toEqual([r, g, b, Math.round(255 * 0.5)])
})

test("a v2 entry overrides the dimmed-palette default of message.discarded.text", () => {
  const prepared = prepare({
    theme: {
      "message.discarded.text": { fg: "#336699", bg: "#000000c8" },
      "message.discarded.marker": { fg: "#abcdef" },
    },
  })
  const discarded = resolveElement(prepared, "message.discarded.text")
  expect(hex(discarded.fg)).toBe("#336699")
  expect(alpha(discarded.bg)).toBe(0xc8)
  expect(hex(resolveElement(prepared, "message.discarded.marker").fg)).toBe("#abcdef")
  // Unrelated rows keep their dimmed-palette defaults.
  const plain = prepare(DEFAULT_THEMES.opencode)
  expect(resolveElement(prepared, "sidebar.discard.row").fg).toEqual(plain.theme.textMuted)
})

test("dimmed-palette follows the theme palette of migrated v1 files", () => {
  // J18: the discarded foreground follows palette textMuted of the active
  // theme, including a migrated v1 file that overrides it.
  const prepared = prepare({ theme: { textMuted: "#112233" } })
  const discarded = resolveElement(prepared, "message.discarded.text")
  expect(hex(discarded.fg)).toBe("#112233")
  expect(discarded.fg.toInts()).toEqual([0x11, 0x22, 0x33, 0x96])
})

test("catalog agent rotation rows match the spec (R39)", () => {
  const palette = (name: string) => ({ source: "palette", name }) as const
  expect(CATALOG["agent.color.one"]).toEqual({ fg: palette("secondary") })
  expect(CATALOG["agent.color.two"]).toEqual({ fg: palette("accent") })
  expect(CATALOG["agent.color.three"]).toEqual({ fg: palette("success") })
  expect(CATALOG["agent.color.four"]).toEqual({ fg: palette("warning") })
  expect(CATALOG["agent.color.five"]).toEqual({ fg: palette("primary") })
  expect(CATALOG["agent.color.six"]).toEqual({ fg: palette("error") })
  expect(CATALOG["agent.color.seven"]).toEqual({ fg: palette("info") })
  // Rotation order: the fg defaults cycle secondary, accent, success, warning,
  // primary, error, info — the pre-v2 flat-palette rotation (R39.6).
  const rotation = Object.keys(CATALOG)
    .filter((name) => name.startsWith("agent.color."))
  expect(rotation).toEqual([
    "agent.color.one",
    "agent.color.two",
    "agent.color.three",
    "agent.color.four",
    "agent.color.five",
    "agent.color.six",
    "agent.color.seven",
  ])
  // The zone sits between its consumer zones prompt and message (J15).
  const keys = Object.keys(CATALOG)
  expect(keys.indexOf("agent.color.one")).toBeGreaterThan(keys.indexOf("prompt.extmark.paste"))
  expect(keys.indexOf("agent.color.seven")).toBeLessThan(keys.indexOf("message.user.body"))
})

test("catalog matches the spec errata v1.1 element set", () => {
  // Elements dropped by the errata: markdown.code split into inline/block,
  // prompt.cursor.unfocused has no live surface.
  expect(isElementName("markdown.code")).toBe(false)
  expect(isElementName("prompt.cursor.unfocused")).toBe(false)
  // Every element added by the errata, per the spec tables.
  const added = [
    "dialog.route.warning",
    "dialog.route.home",
    "dialog.changes.list",
    "dialog.changes.added",
    "dialog.changes.removed",
    "dialog.provider.connected",
    "dialog.status.ok",
    "dialog.status.warn",
    "dialog.status.error",
    "dialog.prompt.cursor.busy",
    "autocomplete.muted",
    "prompt.meta",
    "prompt.retry",
    "prompt.interrupt",
    "prompt.editor.pending",
    "message.user.file",
    "message.tool.card.border",
    "message.tool.gutter",
    "sidebar.getting-started",
    "diff.filetree.row.selected.name",
    "markdown.code.inline",
    "markdown.code.block",
    "markdown.label",
    "markdown.underline",
    "syntax.keyword.import",
    "syntax.escape",
    "syntax.tag.attribute",
    "syntax.type.definition",
    "syntax.type.keyword",
    "syntax.error.strong",
    "syntax.comment.error",
    "syntax.comment.warning",
    "syntax.warning.strong",
    "syntax.comment.todo",
    "toast.success.border",
    "toast.warning.border",
    "permission.marker.reject",
    "permission.bar",
    "permission.body",
    "permission.text",
    "permission.text.cursor",
    "question.option.hover.number",
    "question.body",
    "question.review",
    "question.text",
    "question.text.cursor",
    "question.hint",
    "which-key.text",
    "which-key.muted",
    "subagent.footer.muted",
    "run.block.diff.added",
    "run.block.diff.removed",
    "run.block.diff.added-bg",
    "run.block.diff.removed-bg",
    "run.block.diff.context-bg",
    "run.block.diff.highlight-added",
    "run.block.diff.highlight-removed",
    "run.block.diff.line-number",
    "run.block.diff.added-line-number-bg",
    "run.block.diff.removed-line-number-bg",
  ]
  expect(added.length).toBe(60)
  for (const name of added) expect(isElementName(name)).toBe(true)
})

test("catalog defaults match the spec errata v1.1 changed rows", () => {
  const palette = (name: string) => ({ source: "palette", name }) as const
  expect(CATALOG["permission.border"]).toEqual({ fg: palette("warning") })
  expect(CATALOG["permission.option"]).toEqual({
    fg: palette("textMuted"),
    bg: palette("backgroundMenu"),
  })
  expect(CATALOG["message.error.body"]).toEqual({ fg: palette("textMuted") })
  expect(CATALOG["question.option.hover"]).toEqual({
    fg: palette("secondary"),
    bg: palette("backgroundElement"),
  })
  expect(CATALOG["prompt.cursor"]).toEqual({ fg: palette("text") })
  expect(CATALOG["dialog.select.row.selected.unfocused"]).toEqual({
    fg: palette("textMuted"),
    bg: palette("backgroundElement"),
  })
  expect(CATALOG["diff.filetree.row.selected"]).toEqual({
    fg: palette("background"),
    bg: palette("primary"),
  })
  expect(CATALOG["scrollbar.track"]).toEqual({ bg: palette("backgroundElement") })
  expect(CATALOG["markdown.link.label"]).toEqual({
    fg: palette("markdownLinkText"),
    attributes: ["underline"],
  })
  expect(CATALOG["syntax.type"]).toEqual({ fg: palette("syntaxType") })
  expect(CATALOG["syntax.diff.plus"]).toEqual({
    fg: palette("diffAdded"),
    bg: palette("diffAddedBg"),
  })
  expect(CATALOG["syntax.diff.minus"]).toEqual({
    fg: palette("diffRemoved"),
    bg: palette("diffRemovedBg"),
  })
  // question-hover-number-tint (Configuration): tint(textMuted, secondary, 0.6)
  expect(CATALOG["question.option.hover.number"]).toEqual({
    fg: { source: "tint", base: palette("textMuted"), overlay: palette("secondary"), alpha: 0.6 },
    bg: palette("backgroundElement"),
  } as const)
  // The base run rendering pinned the diff surfaces transparent (R44, R48):
  // no default entry, so the channel resolves to the transparent color.
  expect(CATALOG["run.block.diff.added-bg"]).toEqual({})
  expect(CATALOG["run.block.diff.removed-bg"]).toEqual({})
  expect(CATALOG["run.block.diff.context-bg"]).toEqual({})
  // logo.shadow has no static default: the renderer blends the background
  // with each half's own foreground, which one row cannot express (R34).
  expect(CATALOG["logo.shadow"]).toEqual({})
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

test("textAttributes maps each attribute name to its renderer flag", () => {
  expect(textAttributes(new Set(["bold"]))).toBe(TextAttributes.BOLD)
  expect(textAttributes(new Set(["dim"]))).toBe(TextAttributes.DIM)
  expect(textAttributes(new Set(["italic"]))).toBe(TextAttributes.ITALIC)
  expect(textAttributes(new Set(["underline"]))).toBe(TextAttributes.UNDERLINE)
  expect(textAttributes(new Set(["blink"]))).toBe(TextAttributes.BLINK)
  expect(textAttributes(new Set(["inverse"]))).toBe(TextAttributes.INVERSE)
  expect(textAttributes(new Set(["hidden"]))).toBe(TextAttributes.HIDDEN)
  expect(textAttributes(new Set(["strikethrough"]))).toBe(TextAttributes.STRIKETHROUGH)
})

test("textAttributes ORs combinations and returns NONE for the empty set", () => {
  expect(
    textAttributes(new Set(["bold", "italic", "strikethrough"])),
  ).toBe(TextAttributes.BOLD | TextAttributes.ITALIC | TextAttributes.STRIKETHROUGH)
  expect(textAttributes(new Set(["dim", "underline"]))).toBe(
    TextAttributes.DIM | TextAttributes.UNDERLINE,
  )
  expect(textAttributes(new Set())).toBe(TextAttributes.NONE)
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
        ["agent.color.one", "fg", "secondary"],
        ["agent.color.two", "fg", "accent"],
        ["agent.color.three", "fg", "success"],
        ["agent.color.four", "fg", "warning"],
        ["agent.color.five", "fg", "primary"],
        ["agent.color.six", "fg", "error"],
        ["agent.color.seven", "fg", "info"],
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
        ["markdown.code.inline", "fg", "markdownCode"],
        ["markdown.code.inline", "bg", "background"],
        ["markdown.code.block", "fg", "markdownCode"],
        ["markdown.underline", "fg", "text"],
        ["syntax.comment", "fg", "syntaxComment"],
        ["syntax.keyword", "fg", "syntaxKeyword"],
        ["syntax.keyword.import", "fg", "syntaxKeyword"],
        ["syntax.string", "fg", "syntaxString"],
        ["syntax.number", "fg", "syntaxNumber"],
        ["syntax.type", "fg", "syntaxType"],
        ["syntax.type.definition", "fg", "syntaxType"],
        ["syntax.error.strong", "fg", "error"],
        ["syntax.warning.strong", "fg", "warning"],
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
        ["permission.border", "fg", "warning"],
        ["permission.option", "fg", "textMuted"],
        ["permission.marker.reject", "fg", "error"],
        ["permission.bar", "bg", "backgroundElement"],
        ["message.error.body", "fg", "textMuted"],
        ["prompt.cursor", "fg", "text"],
        ["dialog.select.row.selected.unfocused", "fg", "textMuted"],
        ["dialog.select.row.selected.unfocused", "bg", "backgroundElement"],
        ["dialog.route.warning", "fg", "warning"],
        ["dialog.route.home", "bg", "backgroundElement"],
        ["dialog.changes.list", "bg", "backgroundElement"],
        ["dialog.changes.added", "fg", "diffAdded"],
        ["dialog.changes.removed", "fg", "diffRemoved"],
        ["dialog.prompt.cursor.busy", "fg", "backgroundElement"],
        ["question.option.hover", "fg", "secondary"],
        ["question.option.hover", "bg", "backgroundElement"],
        ["scrollbar.track", "bg", "backgroundElement"],
        ["toast.success.border", "fg", "success"],
        ["toast.warning.border", "fg", "warning"],
        ["sidebar.getting-started", "bg", "backgroundElement"],
        ["diff.filetree.row.selected", "fg", "background"],
        ["diff.filetree.row.selected", "bg", "primary"],
        ["diff.filetree.row.selected.name", "fg", "primary"],
        ["run.block.diff.added", "fg", "diffAdded"],
        ["run.block.diff.removed", "fg", "diffRemoved"],
        ["run.block.diff.added-bg", "bg", "#00000000"],
        ["run.block.diff.removed-bg", "bg", "#00000000"],
        ["run.block.diff.context-bg", "bg", "#00000000"],
        ["run.block.diff.highlight-added", "fg", "diffHighlightAdded"],
        ["run.block.diff.highlight-removed", "fg", "diffHighlightRemoved"],
        ["run.block.diff.line-number", "fg", "diffLineNumber"],
        ["run.block.diff.added-line-number-bg", "bg", "diffAddedLineNumberBg"],
        ["run.block.diff.removed-line-number-bg", "bg", "diffRemovedLineNumberBg"],
        // Discarded-block rows: the marker trio and the sidebar pair resolve
        // to the flat palette reads they replace (R52); the dimmed row is
        // asserted separately through the alpha-multiply rule below.
        ["message.discarded.marker", "fg", "textMuted"],
        ["message.discarded.pending", "fg", "text"],
        ["message.discarded.error", "fg", "error"],
        ["sidebar.discard.header", "fg", "text"],
        ["sidebar.discard.row", "fg", "textMuted"],
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
      // question-hover-number-tint (Configuration): tint(textMuted, secondary, 0.6)
      expect(resolveElement(prepared, "question.option.hover.number").fg).toEqual(
        tint(flat.textMuted, flat.secondary, 0.6),
      )
      expect(resolveElement(prepared, "question.option.hover.number").bg).toEqual(
        flat.backgroundElement,
      )
      // discarded-alpha (Configuration): dimmed(textMuted, 0x96/255) keeps the
      // palette RGB and multiplies the fully opaque palette alpha.
      expect(resolveElement(prepared, "message.discarded.text").fg).toEqual(
        RGBA.fromValues(flat.textMuted.r, flat.textMuted.g, flat.textMuted.b, flat.textMuted.a * (0x96 / 255)),
      )
      // errata v1.1 attribute changes: markdown.link.label gains underline,
      // syntax.type drops bold
      expect(attrs(resolveElement(prepared, "markdown.link.label").attributes)).toEqual([
        "underline",
      ])
      expect(attrs(resolveElement(prepared, "syntax.type").attributes)).toEqual([])
      expect(attrs(resolveElement(prepared, "markdown.code.inline").attributes)).toEqual([])
    }
  }
})

test("LEGACY_COLOR_KEYS mirrors the legacy Theme color keys exactly (R22)", () => {
  // Compile-time drift guard: the satisfies check fails to compile when the
  // legacy Theme type gains or loses a color key without this literal
  // following. `thinkingOpacity` and `_hasSelectedListItemText` are not
  // colors and stay outside both the type and the list.
  const expected = {
    primary: true,
    secondary: true,
    accent: true,
    error: true,
    warning: true,
    success: true,
    info: true,
    text: true,
    textMuted: true,
    selectedListItemText: true,
    background: true,
    backgroundPanel: true,
    backgroundElement: true,
    backgroundMenu: true,
    border: true,
    borderActive: true,
    borderSubtle: true,
    diffAdded: true,
    diffRemoved: true,
    diffContext: true,
    diffHunkHeader: true,
    diffHighlightAdded: true,
    diffHighlightRemoved: true,
    diffAddedBg: true,
    diffRemovedBg: true,
    diffContextBg: true,
    diffLineNumber: true,
    diffAddedLineNumberBg: true,
    diffRemovedLineNumberBg: true,
    markdownText: true,
    markdownHeading: true,
    markdownLink: true,
    markdownLinkText: true,
    markdownCode: true,
    markdownBlockQuote: true,
    markdownEmph: true,
    markdownStrong: true,
    markdownHorizontalRule: true,
    markdownListItem: true,
    markdownListEnumeration: true,
    markdownImage: true,
    markdownImageText: true,
    markdownCodeBlock: true,
    syntaxComment: true,
    syntaxKeyword: true,
    syntaxFunction: true,
    syntaxVariable: true,
    syntaxString: true,
    syntaxNumber: true,
    syntaxType: true,
    syntaxOperator: true,
    syntaxPunctuation: true,
  } satisfies Record<ThemeColor, true>
  expect(LEGACY_COLOR_KEYS.length).toBe(52)
  expect(new Set(LEGACY_COLOR_KEYS).size).toBe(52)
  expect(new Set<string>(LEGACY_COLOR_KEYS)).toEqual(new Set(Object.keys(expected)))
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

test("a v2 theme recolors the agent rotation through agent.color entries", () => {
  const prepared = prepare({ theme: { "agent.color.two": { fg: "#ff00ff" } } })
  // Untouched slots keep their palette-derived defaults; the overridden slot
  // recolors every surface painted from it (the second rotation color, hence
  // the queued chip background of that agent, R39.2/R49).
  expect(resolveElement(prepared, "agent.color.one").fg).toEqual(prepared.theme.secondary)
  expect(hex(resolveElement(prepared, "agent.color.two").fg)).toBe("#ff00ff")
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

const config = createTuiResolvedConfig()

// Unique KV state per mount: the provider persists the mode lock there and the
// tests must not leak a lock across mounts or parallel bun processes.
function stateDir() {
  return path.join("/tmp/opencode", "tui-theme-v2-test", crypto.randomUUID())
}

async function pollUntil(predicate: () => boolean, timeout = 5000) {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeout) throw new Error("timed out waiting for theme propagation")
    await Bun.sleep(20)
  }
}

test("element accessor re-evaluates on theme and mode change and throws on unknown names", async () => {
  // Mounted through the real ThemeProvider: the accessor under test is the
  // context's own `element(name)` (R42), fed by the provider's prepared-theme
  // memo — not a test replica of it.
  let state: ReturnType<typeof useTheme> | undefined
  let observed = ""
  let reads = 0
  function Probe() {
    const theme = useTheme()
    state = theme
    createEffect(() => {
      observed = hex(theme.element("dialog.body").fg)
      reads++
    })
    return <box />
  }
  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: stateDir() }}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <Probe />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 20, height: 4 },
  )
  try {
    // The provider gates children on readiness (theme discovery), so the
    // first observation lands after the async mount settles.
    await pollUntil(() => !!state?.ready && reads > 0)

    // Mode change: the accessor re-evaluates to the mode's palette value.
    const flipped = state!.mode() === "dark" ? "light" : "dark"
    state!.setMode(flipped)
    const modeHex = hex(resolveElement(prepare(DEFAULT_THEMES.opencode, flipped), "dialog.body").fg)
    await pollUntil(() => observed === modeHex)

    // Theme change: it re-evaluates to the switched theme's value.
    expect(state!.set("matrix")).toBe(true)
    const themeHex = hex(resolveElement(prepare(DEFAULT_THEMES.matrix, flipped), "dialog.body").fg)
    await pollUntil(() => observed === themeHex)
    expect(reads).toBe(3)

    // Resolved channels match the resolveElement oracle for the active theme.
    const oracle = prepare(DEFAULT_THEMES.matrix, flipped)
    expect(state!.element("dialog.body")).toEqual(resolveElement(oracle, "dialog.body"))
    expect(state!.element("app.background")).toEqual(resolveElement(oracle, "app.background"))
    expect(state!.element("dialog.title")).toEqual(resolveElement(oracle, "dialog.title"))

    // Non-catalog names throw (R43), including proxy escape hatches.
    expect(() => state!.element("dialog.nope")).toThrow()
    expect(() => state!.element("toString")).toThrow()
  } finally {
    state?.unlock()
    state?.set("opencode")
    app.renderer.destroy()
  }
})
