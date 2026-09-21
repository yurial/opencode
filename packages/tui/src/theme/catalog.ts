import { TextAttributes, type RGBA } from "@opentui/core"

/**
 * One text attribute accepted in an element `attributes` array (R16).
 *
 * Purpose: the closed attribute vocabulary of format v2.
 *
 * Contract: exactly the eight names of the @opentui/core `TextAttributes` set
 * (J8); any other name in an `attributes` array makes the file invalid with
 * `UNKNOWN_ATTRIBUTE`.
 */
export type Attribute =
  | "bold"
  | "dim"
  | "italic"
  | "underline"
  | "blink"
  | "inverse"
  | "hidden"
  | "strikethrough"

/**
 * A color value of the `fg`/`bg` channels and of `defs` members (R15).
 *
 * Purpose: the value grammar shared by format v1 and v2.
 *
 * Contract: exactly one of — a hex string of 3, 4, 6, or 8 hex digits; an
 * integer ANSI index 0–255; the string `none` or `transparent`; a reference
 * name (dotless → `defs` then palette, dotted → catalog element, resolved
 * channel-wise); or a `{dark, light}` variant object holding a color value of
 * any form in each arm. A `RGBA` instance is accepted at runtime for
 * programmatic sources (the generated `system` theme) but is not part of the
 * file grammar.
 */
export type ColorValue = string | number | { dark: ColorValue; light: ColorValue }

/**
 * One element entry of a v2 theme file (tui-theme/element-style).
 *
 * Purpose: the per-element override shape of format v2.
 *
 * Contract: every member is optional; any member outside `fg`/`bg`/`attributes`
 * makes the file invalid (`INVALID_ENTRY`, R14); `attributes` must be an array
 * of `Attribute` names and, when present, replaces the default attribute set
 * wholesale (R26).
 */
export type ElementStyle = {
  fg?: ColorValue
  bg?: ColorValue
  attributes?: Attribute[]
}

/**
 * A v2 theme file document (tui-theme/theme-file).
 *
 * Purpose: the authoring surface of format v2.
 *
 * Contract: `$schema` is informational and never affects behavior; `defs`
 * holds named color constants referenced by dotless reference names; `theme`
 * maps element names to `ElementStyle` entries and may carry the
 * `thinkingOpacity` scalar (the only non-element key allowed, R19/R20).
 */
export type ThemeFileV2 = {
  $schema?: string
  defs?: Record<string, ColorValue>
  theme: Record<string, ElementStyle> & { thinkingOpacity?: number }
}

/**
 * The resolved view of one catalog element (R42).
 *
 * Purpose: what the reactive `element(name)` accessor returns.
 *
 * Contract: `fg` and `bg` are always concrete colors (transparent when no
 * default exists); `attributes` is a read-only set (empty when no default).
 * Attribute values are only meaningful to the renderer when actually
 * supported; the set is immutable from the consumer's side.
 */
export type ResolvedElement = {
  fg: RGBA
  bg: RGBA
  attributes: ReadonlySet<Attribute>
}

/**
 * One default channel of a catalog element.
 *
 * Purpose: encodes the Element catalog tables as data — palette references,
 * literal hex values, the computed `selected-foreground` rule (R33), the
 * element's own foreground, and computed `tint(...)` blends (R34).
 *
 * Contract: `transparent` is the transparent color; `palette` names a legacy
 * palette key; `hex` is a literal `#rrggbb[aa]` string; `selected-foreground`
 * evaluates against the element's own resolved background (R32);
 * `element-foreground` is the resolved foreground of the same element;
 * `tint` blends resolved `base` and `overlay` with the fixed `alpha` share.
 * A channel with no default entry resolves to the transparent color.
 */
export type ColorDefault =
  | { readonly source: "transparent" }
  | { readonly source: "palette"; readonly name: string }
  | { readonly source: "hex"; readonly value: string }
  | { readonly source: "selected-foreground" }
  | { readonly source: "element-foreground" }
  | {
      readonly source: "tint"
      readonly base: ColorDefault
      readonly overlay: ColorDefault
      readonly alpha: number
    }

/**
 * The catalog default of one element.
 *
 * Purpose: one row of the Element catalog tables.
 *
 * Contract: every channel is optional; a missing channel resolves to the
 * transparent color (`fg`/`bg`) or the empty set (`attributes`). Border
 * elements paint single-color strokes on the `fg` channel.
 */
export type ElementDefault = {
  readonly fg?: ColorDefault
  readonly bg?: ColorDefault
  readonly attributes?: readonly Attribute[]
}

/**
 * The eight accepted attribute names as a runtime list (R16).
 *
 * Purpose: validation of `attributes` arrays against the closed vocabulary.
 *
 * Contract: order is presentation only; membership decides acceptance.
 */
export const ATTRIBUTES: readonly Attribute[] = [
  "bold",
  "dim",
  "italic",
  "underline",
  "blink",
  "inverse",
  "hidden",
  "strikethrough",
]

const palette = (name: string): ColorDefault => ({ source: "palette", name })
const hex = (value: string): ColorDefault => ({ source: "hex", value })
const selected = (): ColorDefault => ({ source: "selected-foreground" })
const tintOf = (base: ColorDefault, overlay: ColorDefault, alpha: number): ColorDefault => ({
  source: "tint",
  base,
  overlay,
  alpha,
})

const BACKGROUND: ColorDefault = palette("background")
const BACKGROUND_PANEL: ColorDefault = palette("backgroundPanel")
const BACKGROUND_ELEMENT: ColorDefault = palette("backgroundElement")
const BACKGROUND_MENU: ColorDefault = palette("backgroundMenu")
const TEXT: ColorDefault = palette("text")
const TEXT_MUTED: ColorDefault = palette("textMuted")
const PRIMARY: ColorDefault = palette("primary")
const SECONDARY: ColorDefault = palette("secondary")
const ACCENT: ColorDefault = palette("accent")
const ERROR: ColorDefault = palette("error")
const WARNING: ColorDefault = palette("warning")
const SUCCESS: ColorDefault = palette("success")
const INFO: ColorDefault = palette("info")
const BORDER: ColorDefault = palette("border")
const BORDER_ACTIVE: ColorDefault = palette("borderActive")
const BORDER_SUBTLE: ColorDefault = palette("borderSubtle")
const SELECTED_LIST_ITEM_TEXT: ColorDefault = palette("selectedListItemText")

// question-hover-number-tint (Configuration): the tint share of the
// `question.option.hover.number` foreground (R34).
const QUESTION_HOVER_NUMBER_TINT = 0.6

const APP = {
  "app.background": { bg: BACKGROUND },
} as const

const DIALOG = {
  "dialog.panel": { bg: BACKGROUND_PANEL },
  "dialog.underlay": { bg: hex("#00000096") },
  "dialog.title": { fg: TEXT, attributes: ["bold"] },
  "dialog.body": { fg: TEXT },
  "dialog.muted": { fg: TEXT_MUTED },
  "dialog.action": { fg: selected(), bg: PRIMARY },
  "dialog.link": { fg: PRIMARY },
  "dialog.notice": { fg: ACCENT },
  "dialog.error": { fg: ERROR, bg: BACKGROUND_PANEL },
  "dialog.retry": { fg: selected(), bg: BACKGROUND_PANEL },
  "dialog.route.warning": { fg: WARNING },
  "dialog.route.home": { fg: TEXT, bg: BACKGROUND_ELEMENT },
  "dialog.session.gutter": { fg: ACCENT },
  "dialog.session.deleted": { bg: ERROR },
  "dialog.changes.list": { bg: BACKGROUND_ELEMENT },
  "dialog.changes.added": { fg: palette("diffAdded") },
  "dialog.changes.removed": { fg: palette("diffRemoved") },
  "dialog.console.email": { fg: ACCENT },
  "dialog.plugins.active": { fg: SUCCESS },
  "dialog.plugins.inactive": { fg: ERROR },
  "dialog.mcp.enabled": { fg: SUCCESS },
  "dialog.provider.connected": { fg: SUCCESS },
  "dialog.status.ok": { fg: SUCCESS },
  "dialog.status.warn": { fg: WARNING },
  "dialog.status.error": { fg: ERROR },
  "dialog.debug.copied": { fg: SUCCESS },
  "dialog.export.option": { fg: TEXT },
  "dialog.export.option.active": { fg: PRIMARY, bg: BACKGROUND_ELEMENT },
  "dialog.prompt.cursor.busy": { fg: BACKGROUND_ELEMENT },
} as const

const DIALOG_SELECT = {
  "dialog.select.filter": { fg: TEXT_MUTED, bg: BACKGROUND_PANEL },
  "dialog.select.filter.cursor": { fg: PRIMARY },
  "dialog.select.row": { fg: TEXT },
  "dialog.select.row.selected": { fg: selected(), bg: PRIMARY, attributes: ["bold"] },
  "dialog.select.row.selected.unfocused": { fg: TEXT_MUTED, bg: BACKGROUND_ELEMENT },
  "dialog.select.category": { fg: ACCENT, attributes: ["bold"] },
  "dialog.select.footer": { fg: TEXT },
  "dialog.select.footer.label": { fg: TEXT_MUTED },
  "dialog.select.footer.active": { fg: selected(), bg: PRIMARY, attributes: ["bold"] },
  "dialog.select.footer.disabled": { fg: TEXT_MUTED },
  "dialog.select.marker": { fg: PRIMARY },
} as const

const AUTOCOMPLETE = {
  "autocomplete.menu": { bg: BACKGROUND_MENU },
  "autocomplete.menu.border": { fg: BORDER },
  "autocomplete.row": { fg: TEXT },
  "autocomplete.row.selected": { fg: selected(), bg: PRIMARY },
  "autocomplete.muted": { fg: TEXT_MUTED },
} as const

const PROMPT = {
  "prompt.container": { bg: BACKGROUND_ELEMENT },
  "prompt.container.border": { fg: BORDER },
  "prompt.shell.border": { fg: PRIMARY },
  "prompt.text": { fg: TEXT },
  "prompt.placeholder": { fg: TEXT_MUTED },
  "prompt.cursor": { fg: TEXT },
  "prompt.cursor.disabled": { bg: BACKGROUND_ELEMENT },
  "prompt.notice": { fg: ACCENT },
  "prompt.chip": { fg: TEXT, bg: BACKGROUND_ELEMENT },
  "prompt.meta": { fg: TEXT_MUTED },
  "prompt.retry": { fg: ERROR },
  "prompt.interrupt": { fg: PRIMARY },
  "prompt.editor.pending": { fg: SECONDARY },
  "prompt.extmark.file": { fg: WARNING, attributes: ["bold"] },
  "prompt.extmark.agent": { fg: SECONDARY, attributes: ["bold"] },
  "prompt.extmark.paste": { fg: selected(), bg: WARNING, attributes: ["bold"] },
} as const

const MESSAGE = {
  "message.user.body": { fg: TEXT, bg: BACKGROUND_PANEL },
  "message.user.body.hover": { fg: TEXT, bg: BACKGROUND_ELEMENT },
  "message.user.badge": { fg: selected(), bg: SECONDARY },
  "message.user.file": { fg: TEXT_MUTED, bg: BACKGROUND_ELEMENT },
  "message.assistant.body": { fg: TEXT },
  "message.assistant.meta": { fg: TEXT_MUTED },
  "message.assistant.meta.mode": { fg: TEXT },
  "message.assistant.meta.variant": { fg: WARNING, attributes: ["bold"] },
  "message.system.body": { fg: TEXT_MUTED },
  "message.reasoning.header": { fg: WARNING },
  "message.reasoning.body": { fg: TEXT_MUTED },
  "message.tool.card": { bg: BACKGROUND_PANEL },
  "message.tool.card.hover": { bg: BACKGROUND_MENU },
  "message.tool.card.border": { fg: BACKGROUND },
  "message.tool.gutter": { fg: TEXT_MUTED },
  "message.tool.header": { fg: TEXT_MUTED },
  "message.tool.body": { fg: TEXT },
  "message.tool.body.pending": { fg: TEXT_MUTED },
  "message.tool.status.pending": { fg: WARNING },
  "message.tool.status.error": { fg: ERROR },
  "message.tool.status.done": { fg: TEXT_MUTED },
  "message.tool.args.denied": { fg: TEXT, attributes: ["strikethrough"] },
  "message.error.panel": { bg: BACKGROUND_PANEL },
  "message.error.border": { fg: ERROR },
  "message.error.body": { fg: TEXT_MUTED },
  "message.revert": { fg: TEXT_MUTED, bg: BACKGROUND_PANEL },
  "message.revert.hover": { fg: TEXT_MUTED, bg: BACKGROUND_ELEMENT },
  "message.queued": { fg: TEXT_MUTED, attributes: ["bold"] },
  "message.timestamp": { fg: TEXT_MUTED },
  "message.compaction": { fg: BORDER_ACTIVE },
} as const

const FOOTER = {
  "footer.panel": { bg: BACKGROUND_PANEL },
  "footer.text": { fg: TEXT },
  "footer.muted": { fg: TEXT_MUTED },
  "footer.permission": { fg: WARNING },
  "footer.status.ok": { fg: SUCCESS },
  "footer.status.warn": { fg: WARNING },
  "footer.status.error": { fg: ERROR },
} as const

const SIDEBAR = {
  "sidebar.panel": { bg: BACKGROUND_PANEL },
  "sidebar.dim": { bg: hex("#00000046") },
  "sidebar.text": { fg: TEXT },
  "sidebar.muted": { fg: TEXT_MUTED },
  "sidebar.strong": { fg: TEXT, attributes: ["bold"] },
  "sidebar.emphasized": { fg: TEXT, attributes: ["italic"] },
  "sidebar.item.open": { fg: SUCCESS },
  "sidebar.status.ok": { fg: SUCCESS },
  "sidebar.status.warn": { fg: WARNING },
  "sidebar.status.error": { fg: ERROR },
  "sidebar.todo.pending": { fg: WARNING },
  "sidebar.getting-started": { bg: BACKGROUND_ELEMENT },
  "sidebar.files.added": { fg: palette("diffAdded") },
  "sidebar.files.removed": { fg: palette("diffRemoved") },
} as const

const SCROLLBAR = {
  "scrollbar.track": { bg: BACKGROUND_ELEMENT },
  "scrollbar.track.overlay": { bg: BACKGROUND },
  "scrollbar.thumb": { fg: BORDER },
  "scrollbar.thumb.active": { fg: BORDER_ACTIVE },
} as const

const DIFF = {
  "diff.text": { fg: TEXT },
  "diff.border": { fg: BORDER },
  "diff.line.added": { fg: TEXT, bg: palette("diffAddedBg") },
  "diff.line.removed": { fg: TEXT, bg: palette("diffRemovedBg") },
  "diff.line.context": { fg: TEXT, bg: palette("diffContextBg") },
  "diff.sign.added": { fg: palette("diffHighlightAdded") },
  "diff.sign.removed": { fg: palette("diffHighlightRemoved") },
  "diff.gutter": { fg: palette("diffLineNumber"), bg: palette("diffContextBg") },
  "diff.gutter.added": { fg: palette("diffLineNumber"), bg: palette("diffAddedLineNumberBg") },
  "diff.gutter.removed": { fg: palette("diffLineNumber"), bg: palette("diffRemovedLineNumberBg") },
  "diff.banner.added": { fg: palette("diffAdded") },
  "diff.banner.removed": { fg: palette("diffRemoved") },
  "diff.filetree.row": { fg: TEXT_MUTED },
  "diff.filetree.row.selected": { fg: BACKGROUND, bg: PRIMARY },
  "diff.filetree.row.selected.name": { fg: PRIMARY },
} as const

const MARKDOWN = {
  "markdown.text": { fg: palette("markdownText") },
  "markdown.bg": { bg: BACKGROUND },
  "markdown.heading": { fg: palette("markdownHeading"), attributes: ["bold"] },
  "markdown.heading.h1": { fg: palette("markdownHeading"), attributes: ["bold", "underline"] },
  "markdown.strong": { fg: palette("markdownStrong"), attributes: ["bold"] },
  "markdown.emph": { fg: palette("markdownEmph"), attributes: ["italic"] },
  "markdown.quote": { fg: palette("markdownBlockQuote"), attributes: ["italic"] },
  "markdown.list": { fg: palette("markdownListItem") },
  "markdown.code.inline": { fg: palette("markdownCode"), bg: BACKGROUND },
  "markdown.code.block": { fg: palette("markdownCode") },
  "markdown.link": { fg: palette("markdownLink"), attributes: ["underline"] },
  "markdown.link.label": { fg: palette("markdownLinkText"), attributes: ["underline"] },
  "markdown.label": { fg: palette("markdownLinkText") },
  "markdown.underline": { fg: TEXT, attributes: ["underline"] },
} as const

const SYNTAX = {
  "syntax.default": { fg: TEXT },
  "syntax.comment": { fg: palette("syntaxComment"), attributes: ["italic"] },
  "syntax.keyword": { fg: palette("syntaxKeyword"), attributes: ["italic"] },
  "syntax.keyword.import": { fg: palette("syntaxKeyword") },
  "syntax.escape": { fg: palette("syntaxKeyword") },
  "syntax.tag.attribute": { fg: palette("syntaxKeyword") },
  "syntax.string": { fg: palette("syntaxString") },
  "syntax.number": { fg: palette("syntaxNumber") },
  "syntax.type": { fg: palette("syntaxType") },
  "syntax.type.definition": { fg: palette("syntaxType"), attributes: ["bold"] },
  "syntax.type.keyword": { fg: palette("syntaxType"), attributes: ["bold", "italic"] },
  "syntax.function": { fg: palette("syntaxFunction") },
  "syntax.variable": { fg: palette("syntaxVariable") },
  "syntax.operator": { fg: palette("syntaxOperator") },
  "syntax.punctuation": { fg: palette("syntaxPunctuation") },
  "syntax.error": { fg: ERROR },
  "syntax.error.strong": { fg: ERROR, attributes: ["bold"] },
  "syntax.comment.error": { fg: ERROR, attributes: ["italic", "bold"] },
  "syntax.warning": { fg: WARNING },
  "syntax.warning.strong": { fg: WARNING, attributes: ["bold"] },
  "syntax.comment.warning": { fg: WARNING, attributes: ["italic", "bold"] },
  "syntax.todo": { fg: INFO },
  "syntax.comment.todo": { fg: INFO, attributes: ["italic", "bold"] },
  "syntax.checked": { fg: SUCCESS },
  "syntax.conceal": { fg: TEXT_MUTED },
  "syntax.prompt": { fg: ACCENT },
  "syntax.diff.plus": { fg: palette("diffAdded"), bg: palette("diffAddedBg") },
  "syntax.diff.minus": { fg: palette("diffRemoved"), bg: palette("diffRemovedBg") },
  "syntax.diff.delta": { fg: palette("diffContext"), bg: palette("diffContextBg") },
} as const

const TOAST = {
  "toast.panel": { bg: BACKGROUND_PANEL },
  "toast.title": { fg: TEXT, attributes: ["bold"] },
  "toast.body": { fg: TEXT },
  "toast.error.border": { fg: ERROR },
  "toast.info.border": { fg: INFO },
  "toast.success.border": { fg: SUCCESS },
  "toast.warning.border": { fg: WARNING },
} as const

const PERMISSION = {
  "permission.panel": { bg: BACKGROUND_PANEL },
  "permission.border": { fg: WARNING },
  "permission.border.reject": { fg: ERROR },
  "permission.marker": { fg: WARNING },
  "permission.marker.reject": { fg: ERROR },
  "permission.option": { fg: TEXT_MUTED, bg: BACKGROUND_MENU },
  "permission.option.selected": { fg: selected(), bg: WARNING },
  "permission.caption": { fg: TEXT_MUTED },
  "permission.bar": { bg: BACKGROUND_ELEMENT },
  "permission.body": { fg: TEXT },
  "permission.text": { fg: TEXT },
  "permission.text.cursor": { fg: PRIMARY },
} as const

const QUESTION = {
  "question.panel": { bg: BACKGROUND_PANEL },
  "question.border": { fg: ACCENT },
  "question.tab": { fg: TEXT, bg: BACKGROUND_PANEL },
  "question.tab.active": { fg: selected(), bg: ACCENT },
  "question.tab.hover": { fg: TEXT, bg: BACKGROUND_ELEMENT },
  "question.option": { fg: TEXT, bg: BACKGROUND_PANEL },
  "question.option.hover": { fg: SECONDARY, bg: BACKGROUND_ELEMENT },
  "question.option.hover.number": {
    fg: tintOf(TEXT_MUTED, SECONDARY, QUESTION_HOVER_NUMBER_TINT),
    bg: BACKGROUND_ELEMENT,
  },
  "question.option.selected": { fg: selected(), bg: SECONDARY },
  "question.option.picked": { fg: SUCCESS },
  "question.muted": { fg: TEXT_MUTED },
  "question.unanswered": { fg: ERROR },
  "question.body": { fg: TEXT },
  "question.review": { fg: TEXT },
  "question.text": { fg: TEXT },
  "question.text.cursor": { fg: PRIMARY },
  "question.hint": { fg: TEXT },
} as const

const SUBAGENT = {
  "subagent.footer.panel": { bg: BACKGROUND_PANEL },
  "subagent.footer.border": { fg: BORDER },
  "subagent.footer.text": { fg: TEXT },
  "subagent.footer.strong": { fg: TEXT, attributes: ["bold"] },
  "subagent.footer.muted": { fg: TEXT_MUTED },
  "subagent.footer.hover": { fg: TEXT, bg: BACKGROUND_ELEMENT },
} as const

const WHICH_KEY = {
  "which-key.panel": { bg: BACKGROUND_MENU },
  "which-key.text": { fg: TEXT },
  "which-key.muted": { fg: TEXT_MUTED },
  "which-key.key": { fg: WARNING },
  "which-key.subtle": { fg: BORDER_SUBTLE },
  "which-key.tab": { fg: SELECTED_LIST_ITEM_TEXT },
  "which-key.accent": { fg: PRIMARY },
} as const

const STARTUP = {
  "startup.panel": { bg: BACKGROUND_PANEL },
  "startup.loading": { fg: TEXT_MUTED },
} as const

const LOGO = {
  "logo.left": { fg: TEXT_MUTED },
  "logo.right": { fg: TEXT, attributes: ["bold"] },
  // No static default can express the per-half shadow the renderer computes
  // (tint of the background with each half's own foreground), so the row is
  // addressable with no default: transparent means "computed per half", an
  // explicit bg override paints both halves (R34).
  "logo.shadow": {},
} as const

const BG_PULSE = {
  "bg-pulse.panel": { bg: BACKGROUND_PANEL },
  "bg-pulse.accent": { fg: PRIMARY },
  "bg-pulse.base": { bg: tintOf(BACKGROUND, TEXT, 0.62) },
} as const

const TIPS = {
  "tips.marker": { fg: WARNING },
} as const

const RUN = {
  "run.background": { bg: BACKGROUND },
  "run.footer.text": { fg: TEXT },
  "run.footer.muted": { fg: TEXT_MUTED },
  "run.footer.highlight": { fg: PRIMARY },
  "run.footer.warn": { fg: WARNING },
  "run.footer.success": { fg: SUCCESS },
  "run.footer.error": { fg: ERROR },
  "run.footer.selected": { bg: BACKGROUND_ELEMENT },
  "run.footer.selected-text": { fg: SELECTED_LIST_ITEM_TEXT },
  "run.footer.pane": { bg: BACKGROUND_MENU },
  "run.footer.border": { fg: BORDER },
  "run.entry.system": { fg: TEXT_MUTED },
  "run.entry.user": { fg: PRIMARY },
  "run.entry.assistant": { fg: TEXT },
  "run.entry.reasoning": { fg: TEXT_MUTED },
  "run.entry.tool": { fg: TEXT },
  "run.entry.tool.start": { fg: TEXT_MUTED },
  "run.entry.error": { fg: ERROR },
  "run.splash.left": { fg: TEXT_MUTED },
  "run.splash.right": { fg: TEXT },
  "run.block.highlight": { fg: PRIMARY },
  "run.block.warning": { fg: WARNING },
  "run.block.text": { fg: TEXT },
  "run.block.muted": { fg: TEXT_MUTED },
  "run.block.diff.added": { fg: palette("diffAdded") },
  "run.block.diff.removed": { fg: palette("diffRemoved") },
  // The base run rendering pinned the diff surfaces transparent and took the
  // foregrounds and line-number backgrounds from the palette (R48, R44).
  "run.block.diff.added-bg": {},
  "run.block.diff.removed-bg": {},
  "run.block.diff.context-bg": {},
  "run.block.diff.highlight-added": { fg: palette("diffHighlightAdded") },
  "run.block.diff.highlight-removed": { fg: palette("diffHighlightRemoved") },
  "run.block.diff.line-number": { fg: palette("diffLineNumber") },
  "run.block.diff.added-line-number-bg": { bg: palette("diffAddedLineNumberBg") },
  "run.block.diff.removed-line-number-bg": { bg: palette("diffRemovedLineNumberBg") },
} as const

/**
 * The closed element catalog (tui-theme/catalog).
 *
 * Purpose: the single source of truth for valid element names and their
 * per-channel defaults, transcribed from the Element catalog tables of
 * specs/tui-theme.md — 22 zones, one row per element.
 *
 * Contract: a theme file entry whose key is not an own property of this
 * object is invalid (`UNKNOWN_ELEMENT`, R17); an element channel absent from
 * its row resolves to the transparent color or the empty attribute set.
 * Object keys with names like `constructor` are never elements — always test
 * membership with `isElementName`, never with the `in` operator.
 */
export const CATALOG = {
  ...APP,
  ...DIALOG,
  ...DIALOG_SELECT,
  ...AUTOCOMPLETE,
  ...PROMPT,
  ...MESSAGE,
  ...FOOTER,
  ...SIDEBAR,
  ...SCROLLBAR,
  ...DIFF,
  ...MARKDOWN,
  ...SYNTAX,
  ...TOAST,
  ...PERMISSION,
  ...QUESTION,
  ...SUBAGENT,
  ...WHICH_KEY,
  ...STARTUP,
  ...LOGO,
  ...BG_PULSE,
  ...TIPS,
  ...RUN,
} as const satisfies Record<string, ElementDefault>

export type ElementName = keyof typeof CATALOG

/**
 * Catalog membership test for a candidate element name (R17, R43).
 *
 * Purpose: the closed-catalog guard used by load validation and by the
 * reactive accessor.
 *
 * Contract: returns true only for own properties of `CATALOG`; inherited
 * members such as `toString` or `constructor` are never element names.
 */
export function isElementName(name: string): boolean {
  return Object.hasOwn(CATALOG, name)
}

const ATTRIBUTE_FLAGS: Record<Attribute, number> = {
  bold: TextAttributes.BOLD,
  dim: TextAttributes.DIM,
  italic: TextAttributes.ITALIC,
  underline: TextAttributes.UNDERLINE,
  blink: TextAttributes.BLINK,
  inverse: TextAttributes.INVERSE,
  hidden: TextAttributes.HIDDEN,
  strikethrough: TextAttributes.STRIKETHROUGH,
}

/**
 * Converts attribute names into the renderer's attribute bitmask.
 *
 * Purpose: gives components migrating to the element API the @opentui/core
 * attribute bitmask that an element `attributes` array stands for.
 *
 * Contract: `names` is a set whose members are `Attribute` names; the result
 * is the bitwise OR of the corresponding @opentui/core flags (`bold` →
 * `BOLD`, `dim` → `DIM`, `italic` → `ITALIC`, `underline` → `UNDERLINE`,
 * `blink` → `BLINK`, `inverse` → `INVERSE`, `hidden` → `HIDDEN`,
 * `strikethrough` → `STRIKETHROUGH`), and the empty set returns
 * `TextAttributes.NONE`. Never throws and has no undefined behavior: the
 * `Attribute` union is closed and every member has a mapped flag, so any
 * set of valid names yields a defined number.
 */
export function textAttributes(names: ReadonlySet<Attribute>): number {
  let result = TextAttributes.NONE
  for (const name of names) result |= ATTRIBUTE_FLAGS[name]
  return result
}
