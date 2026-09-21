import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import {
  DEFAULT_THEMES,
  generateSubtleSyntax,
  generateSyntax,
  loadTheme,
  resolveElement,
  selectedForeground,
  type PreparedTheme,
  type Theme,
} from "../src/theme"

function prepare(input: unknown, mode: "dark" | "light" = "dark"): PreparedTheme {
  const result = loadTheme(input, mode)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.theme
}

function ints(rgba: RGBA) {
  return rgba.toInts()
}

function expectFlags(style: { bold?: boolean; italic?: boolean; underline?: boolean; dim?: boolean }, element: ReturnType<typeof resolveElement>) {
  expect(style.bold).toBe(element.attributes.has("bold") || undefined)
  expect(style.italic).toBe(element.attributes.has("italic") || undefined)
  expect(style.underline).toBe(element.attributes.has("underline") || undefined)
  expect(style.dim).toBe(element.attributes.has("dim") || undefined)
}

function expectChannels(style: { fg?: RGBA; bg?: RGBA }, element: ReturnType<typeof resolveElement>) {
  if (element.fg.a > 0) expect(ints(style.fg!)).toEqual(ints(element.fg))
  else expect(style.fg).toBeUndefined()
  if (element.bg.a > 0) expect(ints(style.bg!)).toEqual(ints(element.bg))
  else expect(style.bg).toBeUndefined()
}

const prepared = prepare(DEFAULT_THEMES.opencode)
const flat: Theme = prepared.theme

/**
 * The full scope → element rule table (R40, R41) — the specification
 * transcription the implementation must reproduce. Extmark style ids stay
 * `extmark.*` (the prompt editor resolves them via getStyleId) and source
 * their styles from the prompt.extmark.* elements.
 */
const RULE_ELEMENTS: Record<string, string> = {
  default: "syntax.default",
  prompt: "syntax.prompt",
  "extmark.file": "prompt.extmark.file",
  "extmark.agent": "prompt.extmark.agent",
  "extmark.paste": "prompt.extmark.paste",
  comment: "syntax.comment",
  "comment.documentation": "syntax.comment",
  string: "syntax.string",
  symbol: "syntax.string",
  number: "syntax.number",
  boolean: "syntax.number",
  "character.special": "syntax.string",
  "keyword.return": "syntax.keyword",
  "keyword.conditional": "syntax.keyword",
  "keyword.repeat": "syntax.keyword",
  "keyword.coroutine": "syntax.keyword",
  "keyword.type": "syntax.type.keyword",
  "keyword.function": "syntax.function",
  "function.method": "syntax.function",
  keyword: "syntax.keyword",
  "keyword.import": "syntax.keyword.import",
  operator: "syntax.operator",
  "keyword.operator": "syntax.operator",
  "punctuation.delimiter": "syntax.operator",
  "keyword.conditional.ternary": "syntax.operator",
  variable: "syntax.variable",
  "variable.parameter": "syntax.variable",
  "function.method.call": "syntax.variable",
  "function.call": "syntax.variable",
  "variable.member": "syntax.function",
  function: "syntax.function",
  constructor: "syntax.function",
  type: "syntax.type",
  module: "syntax.type",
  constant: "syntax.number",
  property: "syntax.variable",
  class: "syntax.type",
  parameter: "syntax.variable",
  punctuation: "syntax.punctuation",
  "punctuation.bracket": "syntax.punctuation",
  "variable.builtin": "syntax.error",
  "type.builtin": "syntax.error",
  "function.builtin": "syntax.error",
  "module.builtin": "syntax.error",
  "constant.builtin": "syntax.error",
  "variable.super": "syntax.error",
  "string.escape": "syntax.escape",
  "string.regexp": "syntax.escape",
  "keyword.directive": "syntax.keyword",
  "punctuation.special": "syntax.operator",
  "keyword.modifier": "syntax.keyword",
  "keyword.exception": "syntax.keyword",
  "markup.heading": "markdown.heading",
  "markup.heading.1": "markdown.heading.h1",
  "markup.heading.2": "markdown.heading",
  "markup.heading.3": "markdown.heading",
  "markup.heading.4": "markdown.heading",
  "markup.heading.5": "markdown.heading",
  "markup.heading.6": "markdown.heading",
  "markup.bold": "markdown.strong",
  "markup.strong": "markdown.strong",
  "markup.italic": "markdown.emph",
  "markup.list": "markdown.list",
  "markup.quote": "markdown.quote",
  "markup.raw": "markdown.code.block",
  "markup.raw.block": "markdown.code.block",
  "markup.raw.inline": "markdown.code.inline",
  "markup.link": "markdown.link",
  "markup.link.label": "markdown.link.label",
  "markup.link.url": "markdown.link",
  label: "markdown.label",
  spell: "syntax.default",
  nospell: "syntax.default",
  conceal: "syntax.conceal",
  "string.special": "markdown.link",
  "string.special.url": "markdown.link",
  character: "syntax.string",
  float: "syntax.number",
  "comment.error": "syntax.comment.error",
  "comment.warning": "syntax.comment.warning",
  "comment.todo": "syntax.comment.todo",
  "comment.note": "syntax.comment.todo",
  namespace: "syntax.type",
  field: "syntax.variable",
  "type.definition": "syntax.type.definition",
  "keyword.export": "syntax.keyword.import",
  attribute: "syntax.warning",
  annotation: "syntax.warning",
  tag: "syntax.error",
  "tag.attribute": "syntax.tag.attribute",
  "tag.delimiter": "syntax.operator",
  "markup.strikethrough": "syntax.conceal",
  "markup.underline": "markdown.underline",
  "markup.list.checked": "syntax.checked",
  "markup.list.unchecked": "syntax.conceal",
  "diff.plus": "syntax.diff.plus",
  "diff.minus": "syntax.diff.minus",
  "diff.delta": "syntax.diff.delta",
  error: "syntax.error.strong",
  warning: "syntax.warning.strong",
  info: "syntax.todo",
  debug: "syntax.conceal",
}

const syntax = generateSyntax(prepared)

test("every rule scope is registered exactly once under its mapped element", () => {
  expect([...syntax.getRegisteredNames()].sort()).toEqual(Object.keys(RULE_ELEMENTS).sort())
})

test("rule registration order mirrors the legacy highlight list exactly", () => {
  expect(syntax.getRegisteredNames()).toEqual(LEGACY_RULES.flatMap(([scopes]) => scopes))
})

test("syntax zone rules resolve fg and attributes from their elements (R40, R41)", () => {
  for (const [scope, name] of Object.entries(RULE_ELEMENTS)) {
    if (!name.startsWith("syntax.") || name === "syntax.default") continue
    const style = syntax.getStyle(scope)
    expect(style, scope).toBeDefined()
    const element = resolveElement(prepared, name)
    expectChannels(style!, element)
    expectFlags(style!, element)
  }
  // R41: the scope `default` resolves to syntax.default.
  expectChannels(syntax.getStyle("default")!, resolveElement(prepared, "syntax.default"))
})

test("markdown zone rules carry exactly the catalog defaults", () => {
  for (const [scope, name] of Object.entries(RULE_ELEMENTS)) {
    if (!name.startsWith("markdown.")) continue
    const style = syntax.getStyle(scope)
    expect(style, scope).toBeDefined()
    expectChannels(style!, resolveElement(prepared, name))
    expectFlags(style!, resolveElement(prepared, name))
  }
  expect(syntax.getStyle("markup.heading.1")!.underline).toBe(true)
  expect(syntax.getStyle("markup.heading")!.underline).toBeUndefined()
  expect(syntax.getStyle("markup.link")!.underline).toBe(true)
  expect(syntax.getStyle("markup.quote")!.italic).toBe(true)
  // Code blocks stay fg-only; inline code keeps the surface background.
  expect(syntax.getStyle("markup.raw")!.bg).toBeUndefined()
  expect(syntax.getStyle("markup.raw.block")!.bg).toBeUndefined()
  expect(syntax.getStyle("markup.raw.inline")!.bg).toBeDefined()
})

test("extmark rules source the prompt.extmark.* elements under the legacy style ids", () => {
  for (const [scope, name] of Object.entries(RULE_ELEMENTS)) {
    if (!name.startsWith("prompt.extmark.")) continue
    const style = syntax.getStyle(scope)
    expect(style, scope).toBeDefined()
    expectChannels(style!, resolveElement(prepared, name))
    expectFlags(style!, resolveElement(prepared, name))
  }
  // The legacy style ids stay resolvable; the element names are not
  // registered as style ids (unknown dotted scopes fall through prefix
  // inheritance to the `prompt` scope, standard tree-sitter semantics).
  expect(syntax.getStyleId("extmark.file")!).not.toBe(null)
  expect(syntax.getStyleId("extmark.agent")!).not.toBe(null)
  expect(syntax.getStyleId("extmark.paste")!).not.toBe(null)
  // extmark.paste keeps the legacy selected-foreground-over-warning pair.
  const paste = syntax.getStyle("extmark.paste")!
  expect(ints(paste.fg!)).toEqual(ints(selectedForeground(flat, flat.warning)))
  expect(ints(paste.bg!)).toEqual(ints(flat.warning))
  expect(paste.bold).toBe(true)
})

test("every mapped element's attributes are expressible as SyntaxStyle flags", () => {
  const expressible = new Set(["bold", "italic", "underline", "dim"])
  for (const name of new Set(Object.values(RULE_ELEMENTS))) {
    for (const attribute of resolveElement(prepared, name).attributes) {
      expect(expressible.has(attribute), `${name} carries inexpressible attribute "${attribute}"`).toBe(true)
    }
  }
})

/**
 * The complete legacy highlight table at the pre-v2 commit, transcribed in
 * registration order: the foreground palette key (or the computed
 * selected-foreground pair for extmark.paste), the optional background key,
 * and the hardcoded flags every rule had before the element sourcing. The
 * byte-identity baseline for the default theme (R48).
 */
type LegacyStyle = {
  fg: string | ((flat: Theme) => RGBA)
  bg?: string
  bold?: true
  italic?: true
  underline?: true
}

const LEGACY_RULES: [scopes: string[], style: LegacyStyle][] = [
  [["default"], { fg: "text" }],
  [["prompt"], { fg: "accent" }],
  [["extmark.file"], { fg: "warning", bold: true }],
  [["extmark.agent"], { fg: "secondary", bold: true }],
  [["extmark.paste"], { fg: (flat) => selectedForeground(flat, flat.warning), bg: "warning", bold: true }],
  [["comment", "comment.documentation"], { fg: "syntaxComment", italic: true }],
  [["string", "symbol"], { fg: "syntaxString" }],
  [["number", "boolean"], { fg: "syntaxNumber" }],
  [["character.special"], { fg: "syntaxString" }],
  [["keyword.return", "keyword.conditional", "keyword.repeat", "keyword.coroutine"], { fg: "syntaxKeyword", italic: true }],
  [["keyword.type"], { fg: "syntaxType", bold: true, italic: true }],
  [["keyword.function", "function.method"], { fg: "syntaxFunction" }],
  [["keyword"], { fg: "syntaxKeyword", italic: true }],
  [["keyword.import"], { fg: "syntaxKeyword" }],
  [["operator", "keyword.operator", "punctuation.delimiter"], { fg: "syntaxOperator" }],
  [["keyword.conditional.ternary"], { fg: "syntaxOperator" }],
  [["variable", "variable.parameter", "function.method.call", "function.call"], { fg: "syntaxVariable" }],
  [["variable.member", "function", "constructor"], { fg: "syntaxFunction" }],
  [["type", "module"], { fg: "syntaxType" }],
  [["constant"], { fg: "syntaxNumber" }],
  [["property"], { fg: "syntaxVariable" }],
  [["class"], { fg: "syntaxType" }],
  [["parameter"], { fg: "syntaxVariable" }],
  [["punctuation", "punctuation.bracket"], { fg: "syntaxPunctuation" }],
  [["variable.builtin", "type.builtin", "function.builtin", "module.builtin", "constant.builtin"], { fg: "error" }],
  [["variable.super"], { fg: "error" }],
  [["string.escape", "string.regexp"], { fg: "syntaxKeyword" }],
  [["keyword.directive"], { fg: "syntaxKeyword", italic: true }],
  [["punctuation.special"], { fg: "syntaxOperator" }],
  [["keyword.modifier"], { fg: "syntaxKeyword", italic: true }],
  [["keyword.exception"], { fg: "syntaxKeyword", italic: true }],
  [["markup.heading"], { fg: "markdownHeading", bold: true }],
  [["markup.heading.1"], { fg: "markdownHeading", bold: true, underline: true }],
  [["markup.heading.2"], { fg: "markdownHeading", bold: true }],
  [["markup.heading.3"], { fg: "markdownHeading", bold: true }],
  [["markup.heading.4"], { fg: "markdownHeading", bold: true }],
  [["markup.heading.5"], { fg: "markdownHeading", bold: true }],
  [["markup.heading.6"], { fg: "markdownHeading", bold: true }],
  [["markup.bold", "markup.strong"], { fg: "markdownStrong", bold: true }],
  [["markup.italic"], { fg: "markdownEmph", italic: true }],
  [["markup.list"], { fg: "markdownListItem" }],
  [["markup.quote"], { fg: "markdownBlockQuote", italic: true }],
  [["markup.raw", "markup.raw.block"], { fg: "markdownCode" }],
  [["markup.raw.inline"], { fg: "markdownCode", bg: "background" }],
  [["markup.link"], { fg: "markdownLink", underline: true }],
  [["markup.link.label"], { fg: "markdownLinkText", underline: true }],
  [["markup.link.url"], { fg: "markdownLink", underline: true }],
  [["label"], { fg: "markdownLinkText" }],
  [["spell", "nospell"], { fg: "text" }],
  [["conceal"], { fg: "textMuted" }],
  [["string.special", "string.special.url"], { fg: "markdownLink", underline: true }],
  [["character"], { fg: "syntaxString" }],
  [["float"], { fg: "syntaxNumber" }],
  [["comment.error"], { fg: "error", italic: true, bold: true }],
  [["comment.warning"], { fg: "warning", italic: true, bold: true }],
  [["comment.todo", "comment.note"], { fg: "info", italic: true, bold: true }],
  [["namespace"], { fg: "syntaxType" }],
  [["field"], { fg: "syntaxVariable" }],
  [["type.definition"], { fg: "syntaxType", bold: true }],
  [["keyword.export"], { fg: "syntaxKeyword" }],
  [["attribute", "annotation"], { fg: "warning" }],
  [["tag"], { fg: "error" }],
  [["tag.attribute"], { fg: "syntaxKeyword" }],
  [["tag.delimiter"], { fg: "syntaxOperator" }],
  [["markup.strikethrough"], { fg: "textMuted" }],
  [["markup.underline"], { fg: "text", underline: true }],
  [["markup.list.checked"], { fg: "success" }],
  [["markup.list.unchecked"], { fg: "textMuted" }],
  [["diff.plus"], { fg: "diffAdded", bg: "diffAddedBg" }],
  [["diff.minus"], { fg: "diffRemoved", bg: "diffRemovedBg" }],
  [["diff.delta"], { fg: "diffContext", bg: "diffContextBg" }],
  [["error"], { fg: "error", bold: true }],
  [["warning"], { fg: "warning", bold: true }],
  [["info"], { fg: "info" }],
  [["debug"], { fg: "textMuted" }],
]

function legacyDeltas(prepared: PreparedTheme): string[] {
  const rules = generateSyntax(prepared)
  const flat = prepared.theme
  const deltas: string[] = []
  for (const [scopes, legacy] of LEGACY_RULES) {
    for (const scope of scopes) {
      const style = rules.getStyle(scope)
      if (!style) {
        deltas.push(`${scope}: rule missing`)
        continue
      }
      const fg = typeof legacy.fg === "function" ? legacy.fg(flat) : (flat[legacy.fg as keyof Theme] as RGBA)
      if (!style.fg || ints(style.fg).join() !== ints(fg).join()) deltas.push(`${scope}: fg`)
      const bg = legacy.bg ? (flat[legacy.bg as keyof Theme] as RGBA) : undefined
      if (!bg !== !style.bg || (bg && style.bg && ints(style.bg).join() !== ints(bg).join())) deltas.push(`${scope}: bg`)
      if (style.bold !== (legacy.bold || undefined)) deltas.push(`${scope}: bold`)
      if (style.italic !== (legacy.italic || undefined)) deltas.push(`${scope}: italic`)
      if (style.underline !== (legacy.underline || undefined)) deltas.push(`${scope}: underline`)
    }
  }
  return deltas
}

test("default opencode theme is byte-identical to legacy in dark mode (R48)", () => {
  expect(legacyDeltas(prepared)).toEqual([])
})

test("default opencode theme is byte-identical to legacy in light mode (R48)", () => {
  expect(legacyDeltas(prepare(DEFAULT_THEMES.opencode, "light"))).toEqual([])
})

test("extmark legacy output is preserved (warning/secondary bold, paste pair)", () => {
  expect(ints(syntax.getStyle("extmark.file")!.fg!)).toEqual(ints(flat.warning))
  expect(syntax.getStyle("extmark.file")!.bold).toBe(true)
  expect(ints(syntax.getStyle("extmark.agent")!.fg!)).toEqual(ints(flat.secondary))
  expect(syntax.getStyle("extmark.agent")!.bold).toBe(true)
})

test("subtle syntax multiplies the foreground alpha by thinkingOpacity (R37)", () => {
  const full = syntax.getStyle("comment")!
  const subtle = generateSubtleSyntax(prepared).getStyle("comment")!
  const [r, g, b] = ints(full.fg!)
  expect(ints(subtle.fg!)).toEqual([r, g, b, Math.round(0.6 * 255)])
  expect(subtle.italic).toBe(true)
  expect(subtle.bold).toBe(full.bold)
})

test("subtle syntax follows a custom thinkingOpacity and leaves foreground-less rules alone", () => {
  const quiet = prepare({ theme: { thinkingOpacity: 0.25 } })
  const subtle = generateSubtleSyntax(quiet)
  expect(subtle.getStyle("comment")!.fg!.toInts()[3]).toBe(Math.round(0.25 * 255))
  expect(ints(subtle.getStyle("diff.plus")!.bg!)).toEqual(ints(prepare(DEFAULT_THEMES.opencode).theme.diffAddedBg))
  // A transparent foreground omits the channel; the subtle variant leaves it alone.
  const cleared = prepare({ theme: { "syntax.comment": { fg: "transparent" } } })
  expect(generateSubtleSyntax(cleared).getStyle("comment")!.fg).toBeUndefined()
})

test("element entries override the rule styles (R25, R40)", () => {
  const override = prepare({
    theme: { "syntax.comment": { fg: "#ff0000", attributes: ["bold"] } },
  })
  const style = generateSyntax(override).getStyle("comment")!
  expect(ints(style.fg!)).toEqual(ints(RGBA.fromHex("#ff0000")))
  expect(style.bold).toBe(true)
  // A present attributes array replaces the default set wholesale (R26).
  expect(style.italic).toBeUndefined()
})

test("mode switch re-resolves the rules from the mode's palette", () => {
  const light = prepare(DEFAULT_THEMES.opencode, "light")
  const darkFg = syntax.getStyle("comment")!.fg!
  const lightFg = generateSyntax(light).getStyle("comment")!.fg!
  expect(ints(darkFg)).toEqual(ints(resolveElement(prepared, "syntax.comment").fg))
  expect(ints(lightFg)).toEqual(ints(resolveElement(light, "syntax.comment").fg))
  expect(ints(darkFg)).not.toEqual(ints(lightFg))
})

test("the flat palette adapter matches the prepared-theme output for entry-less sources", () => {
  const fromFlat = generateSyntax(prepared.theme)
  expect([...fromFlat.getRegisteredNames()].sort()).toEqual([...syntax.getRegisteredNames()].sort())
  for (const name of syntax.getRegisteredNames()) {
    expect(fromFlat.getStyle(name), name).toEqual(syntax.getStyle(name))
  }
  const subtleFlat = generateSubtleSyntax(prepared.theme)
  const subtlePrepared = generateSubtleSyntax(prepared)
  expect(subtleFlat.getStyle("comment")).toEqual(subtlePrepared.getStyle("comment"))
})
