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
  "keyword.type": "syntax.type",
  "keyword.function": "syntax.function",
  "function.method": "syntax.function",
  keyword: "syntax.keyword",
  "keyword.import": "syntax.keyword",
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
  "string.escape": "syntax.keyword",
  "string.regexp": "syntax.keyword",
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
  "markup.raw": "markdown.code",
  "markup.raw.block": "markdown.code",
  "markup.raw.inline": "markdown.code",
  "markup.link": "markdown.link",
  "markup.link.label": "markdown.link.label",
  "markup.link.url": "markdown.link",
  label: "markdown.link.label",
  spell: "syntax.default",
  nospell: "syntax.default",
  conceal: "syntax.conceal",
  "string.special": "markdown.link",
  "string.special.url": "markdown.link",
  character: "syntax.string",
  float: "syntax.number",
  "comment.error": "syntax.error",
  "comment.warning": "syntax.warning",
  "comment.todo": "syntax.todo",
  "comment.note": "syntax.todo",
  namespace: "syntax.type",
  field: "syntax.variable",
  "type.definition": "syntax.type",
  "keyword.export": "syntax.keyword",
  attribute: "syntax.warning",
  annotation: "syntax.warning",
  tag: "syntax.error",
  "tag.attribute": "syntax.keyword",
  "tag.delimiter": "syntax.operator",
  "markup.strikethrough": "syntax.conceal",
  "markup.underline": "markdown.text",
  "markup.list.checked": "syntax.checked",
  "markup.list.unchecked": "syntax.conceal",
  "diff.plus": "syntax.diff.plus",
  "diff.minus": "syntax.diff.minus",
  "diff.delta": "syntax.diff.delta",
  error: "syntax.error",
  warning: "syntax.warning",
  info: "syntax.todo",
  debug: "syntax.conceal",
}

const syntax = generateSyntax(prepared)

test("every rule scope is registered exactly once under its mapped element", () => {
  expect([...syntax.getRegisteredNames()].sort()).toEqual(Object.keys(RULE_ELEMENTS).sort())
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
 * The legacy highlight table at the previous commit, transcribed scope by
 * scope: the foreground palette key and the hardcoded flags every rule had
 * before the element sourcing (R23 losslessness baseline for the default
 * theme).
 */
const LEGACY_RULES: Record<string, { fg: string; bg?: string; bold?: true; italic?: true; underline?: true }> = {
  default: { fg: "text" },
  prompt: { fg: "accent" },
  comment: { fg: "syntaxComment", italic: true },
  "comment.documentation": { fg: "syntaxComment", italic: true },
  string: { fg: "syntaxString" },
  symbol: { fg: "syntaxString" },
  number: { fg: "syntaxNumber" },
  boolean: { fg: "syntaxNumber" },
  "character.special": { fg: "syntaxString" },
  "keyword.return": { fg: "syntaxKeyword", italic: true },
  "keyword.conditional": { fg: "syntaxKeyword", italic: true },
  "keyword.repeat": { fg: "syntaxKeyword", italic: true },
  "keyword.coroutine": { fg: "syntaxKeyword", italic: true },
  "keyword.function": { fg: "syntaxFunction" },
  "function.method": { fg: "syntaxFunction" },
  keyword: { fg: "syntaxKeyword", italic: true },
  operator: { fg: "syntaxOperator" },
  "keyword.operator": { fg: "syntaxOperator" },
  "punctuation.delimiter": { fg: "syntaxOperator" },
  "keyword.conditional.ternary": { fg: "syntaxOperator" },
  variable: { fg: "syntaxVariable" },
  "variable.parameter": { fg: "syntaxVariable" },
  "function.method.call": { fg: "syntaxVariable" },
  "function.call": { fg: "syntaxVariable" },
  "variable.member": { fg: "syntaxFunction" },
  "function": { fg: "syntaxFunction" },
  "constructor": { fg: "syntaxFunction" },
  constant: { fg: "syntaxNumber" },
  property: { fg: "syntaxVariable" },
  parameter: { fg: "syntaxVariable" },
  punctuation: { fg: "syntaxPunctuation" },
  "punctuation.bracket": { fg: "syntaxPunctuation" },
  "variable.builtin": { fg: "error" },
  "type.builtin": { fg: "error" },
  "function.builtin": { fg: "error" },
  "module.builtin": { fg: "error" },
  "constant.builtin": { fg: "error" },
  "variable.super": { fg: "error" },
  "keyword.directive": { fg: "syntaxKeyword", italic: true },
  "punctuation.special": { fg: "syntaxOperator" },
  "keyword.modifier": { fg: "syntaxKeyword", italic: true },
  "keyword.exception": { fg: "syntaxKeyword", italic: true },
  "markup.heading": { fg: "markdownHeading", bold: true },
  "markup.heading.1": { fg: "markdownHeading", bold: true, underline: true },
  "markup.heading.2": { fg: "markdownHeading", bold: true },
  "markup.heading.3": { fg: "markdownHeading", bold: true },
  "markup.heading.4": { fg: "markdownHeading", bold: true },
  "markup.heading.5": { fg: "markdownHeading", bold: true },
  "markup.heading.6": { fg: "markdownHeading", bold: true },
  "markup.bold": { fg: "markdownStrong", bold: true },
  "markup.strong": { fg: "markdownStrong", bold: true },
  "markup.italic": { fg: "markdownEmph", italic: true },
  "markup.list": { fg: "markdownListItem" },
  "markup.quote": { fg: "markdownBlockQuote", italic: true },
  "markup.raw.inline": { fg: "markdownCode", bg: "background" },
  "markup.link": { fg: "markdownLink", underline: true },
  "markup.link.url": { fg: "markdownLink", underline: true },
  label: { fg: "markdownLinkText" },
  spell: { fg: "text" },
  nospell: { fg: "text" },
  conceal: { fg: "textMuted" },
  "string.special": { fg: "markdownLink", underline: true },
  "string.special.url": { fg: "markdownLink", underline: true },
  character: { fg: "syntaxString" },
  float: { fg: "syntaxNumber" },
  namespace: { fg: "syntaxType" },
  field: { fg: "syntaxVariable" },
  "type.definition": { fg: "syntaxType", bold: true },
  attribute: { fg: "warning" },
  annotation: { fg: "warning" },
  tag: { fg: "error" },
  "tag.delimiter": { fg: "syntaxOperator" },
  "markup.strikethrough": { fg: "textMuted" },
  "markup.list.checked": { fg: "success" },
  "markup.list.unchecked": { fg: "textMuted" },
  "diff.delta": { fg: "diffContext", bg: "diffContextBg" },
  info: { fg: "info" },
  debug: { fg: "textMuted" },
}

// Scopes where the catalog redefines a legacy flag; each has its own test
// below pinning the exact delta against the catalog table.
const CATALOG_DELTAS = new Set([
  "keyword.type",
  "type",
  "module",
  "class",
  "namespace",
  "keyword.import",
  "string.escape",
  "string.regexp",
  "keyword.export",
  "tag.attribute",
  "comment.error",
  "comment.warning",
  "comment.todo",
  "comment.note",
  "error",
  "warning",
  "markup.link.label",
  "markup.underline",
  "markup.raw",
  "markup.raw.block",
  "diff.plus",
  "diff.minus",
])

test("default theme reproduces the legacy highlight output (R23 baseline)", () => {
  for (const [scope, legacy] of Object.entries(LEGACY_RULES)) {
    if (CATALOG_DELTAS.has(scope)) continue
    const style = syntax.getStyle(scope)
    expect(style, scope).toBeDefined()
    expect(ints(style!.fg!), scope).toEqual(ints(flat[legacy.fg as keyof Theme] as RGBA))
    if (legacy.bg) expect(ints(style!.bg!), scope).toEqual(ints(flat[legacy.bg as keyof Theme] as RGBA))
    else expect(style!.bg, scope).toBeUndefined()
    expect(style!.bold, scope).toBe(legacy.bold || undefined)
    expect(style!.italic, scope).toBe(legacy.italic || undefined)
    expect(style!.underline, scope).toBe(legacy.underline || undefined)
  }
})

test("extmark legacy output is preserved (warning/secondary bold, paste pair)", () => {
  expect(ints(syntax.getStyle("extmark.file")!.fg!)).toEqual(ints(flat.warning))
  expect(syntax.getStyle("extmark.file")!.bold).toBe(true)
  expect(ints(syntax.getStyle("extmark.agent")!.fg!)).toEqual(ints(flat.secondary))
  expect(syntax.getStyle("extmark.agent")!.bold).toBe(true)
})

test("catalog redefinition: syntax.type unifies keyword.type and type scopes on bold", () => {
  // Catalog `syntax.type` = { syntaxType, bold }: keyword.type loses the
  // legacy italic, the plain type scopes gain the legacy-less bold.
  expect(ints(syntax.getStyle("keyword.type")!.fg!)).toEqual(ints(flat.syntaxType))
  expect(syntax.getStyle("keyword.type")!.bold).toBe(true)
  expect(syntax.getStyle("keyword.type")!.italic).toBeUndefined()
  for (const scope of ["type", "module", "class", "namespace"]) {
    expect(syntax.getStyle(scope)!.bold, scope).toBe(true)
    expect(syntax.getStyle(scope)!.italic, scope).toBeUndefined()
  }
})

test("catalog redefinition: bare keyword scopes resolve syntax.keyword with italic", () => {
  // Catalog `syntax.keyword` = { syntaxKeyword, italic }: the legacy plain
  // keyword rules gain the element's italic.
  for (const scope of ["keyword.import", "string.escape", "string.regexp", "keyword.export", "tag.attribute"]) {
    expect(ints(syntax.getStyle(scope)!.fg!), scope).toEqual(ints(flat.syntaxKeyword))
    expect(syntax.getStyle(scope)!.italic, scope).toBe(true)
  }
})

test("catalog redefinition: comment.error/warning/todo lose the legacy emphasis", () => {
  // Catalog `syntax.error`/`syntax.warning`/`syntax.todo` carry no attributes.
  expect(syntax.getStyle("comment.error")!.italic).toBeUndefined()
  expect(syntax.getStyle("comment.error")!.bold).toBeUndefined()
  expect(syntax.getStyle("comment.warning")!.italic).toBeUndefined()
  expect(syntax.getStyle("comment.todo")!.italic).toBeUndefined()
  expect(syntax.getStyle("comment.note")!.bold).toBeUndefined()
})

test("catalog redefinition: error and warning scopes lose the legacy bold", () => {
  expect(syntax.getStyle("error")!.bold).toBeUndefined()
  expect(ints(syntax.getStyle("error")!.fg!)).toEqual(ints(flat.error))
  expect(syntax.getStyle("warning")!.bold).toBeUndefined()
  expect(ints(syntax.getStyle("warning")!.fg!)).toEqual(ints(flat.warning))
})

test("catalog redefinition: markdown.link.label loses the legacy underline", () => {
  // Catalog `markdown.link.label` = { markdownLinkText }, no attributes.
  expect(ints(syntax.getStyle("markup.link.label")!.fg!)).toEqual(ints(flat.markdownLinkText))
  expect(syntax.getStyle("markup.link.label")!.underline).toBeUndefined()
})

test("catalog redefinition: markup.underline resolves markdown.text without underline", () => {
  // No markdown.underline element exists; markdown.text keeps the default
  // theme's foreground (markdownText == text there) and drops the flag.
  expect(ints(syntax.getStyle("markup.underline")!.fg!)).toEqual(ints(flat.markdownText))
  expect(syntax.getStyle("markup.underline")!.underline).toBeUndefined()
})

test("catalog redefinition: markup.raw gains the markdown.code background", () => {
  // Catalog `markdown.code` = { markdownCode, background }: the raw-block
  // rules gain the surface background the inline rule already had.
  expect(ints(syntax.getStyle("markup.raw")!.bg!)).toEqual(ints(flat.background))
  expect(ints(syntax.getStyle("markup.raw.block")!.bg!)).toEqual(ints(flat.background))
  expect(ints(syntax.getStyle("markup.raw")!.fg!)).toEqual(ints(flat.markdownCode))
})

test("catalog redefinition: diff.plus/minus drop the legacy diff foregrounds", () => {
  // Catalog rows give them only the diffAddedBg/diffRemovedBg backgrounds —
  // the foreground channel resolves transparent and is omitted.
  expect(syntax.getStyle("diff.plus")!.fg).toBeUndefined()
  expect(ints(syntax.getStyle("diff.plus")!.bg!)).toEqual(ints(flat.diffAddedBg))
  expect(syntax.getStyle("diff.minus")!.fg).toBeUndefined()
  expect(ints(syntax.getStyle("diff.minus")!.bg!)).toEqual(ints(flat.diffRemovedBg))
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
  expect(subtle.getStyle("diff.plus")!.fg).toBeUndefined()
  expect(ints(subtle.getStyle("diff.plus")!.bg!)).toEqual(ints(prepare(DEFAULT_THEMES.opencode).theme.diffAddedBg))
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
