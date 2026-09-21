# TUI Theme (v2 Element Format)

Status: stable
Spec source of truth for: the opencode TUI theme system — the per-element
theme format (v2), the element catalog with defaults, the v1-to-v2 migration,
color and attribute resolution, and theme consumption in the TUI, the run CLI,
and the plugin API — for anyone authoring or tuning a custom theme.

## Overview

This spec fixes how the opencode TUI is themed. Format v2 is fully
per-element: every rendered UI surface is addressed by a dotted element name
(`dialog.title`) and declares an optional foreground, background, and text
attribute set (R13–R20). The element catalog lists every addressable element
with the default channels it inherits from the legacy v1 palette and the
attributes it carries today (Element catalog section). Format v1 — the flat
camelCase color keys — is deprecated and auto-migrated at load (R21–R24);
built-in themes stay as v1 files and go through the same migration. Resolution
order, partial overrides, references, and error behavior are fixed in
R25–R34 and R47. The consumption contract — the reactive `element(name)`
accessor, syntax rules sourcing attributes from the theme, the run CLI
RunTheme, and the plugin API — is fixed in R35–R46. With the default built-in
theme the catalog defaults and the element-sourced rules are byte-identical to
the pre-v2 rendering (R48), and the queued-chip computed override is fixed in
R49.

## Scope

In: the v2 theme-file structure (`$schema`/`defs`/`theme`), the color-value
and attribute grammar, the element catalog and its defaults, format
discrimination and mixing rules, the v1-to-v2 migration, resolution and error
semantics, `thinkingOpacity`, the computed derivations
(tui-theme/selected-foreground, tui-theme/tint, tui-theme/fade, agent dot
rotation), and the consumption surfaces: TUI components, the run CLI theme,
and the plugin theme API.

Out (non-goals): the opencode/opentui renderer sources; SGR rendering and
color quantization; theme discovery directories, selection persistence, and
hot reload (owned by tui-architecture); the web/desktop theme system
(`packages/ui/src/theme`); the crash error-component palette and the
Knight-Rider spinner trail (R46).

## Definitions

Definitions used throughout (full IDs, `tui-theme/<term>`):

- `tui-theme/theme-file` — the theme JSON document: `$schema`, `defs`,
  `theme`.
- `tui-theme/v1-format` — the legacy flat format whose `theme` member maps
  legacy camelCase color keys (plus the `thinkingOpacity` scalar); deprecated,
  auto-migrated at load.
- `tui-theme/v2-format` — the per-element format whose `theme` member maps
  tui-theme/element names to tui-theme/element-style entries.
- `tui-theme/element` — a dotted lowercase name contained in the catalog,
  identifying one rendered UI surface or one of its channels.
- `tui-theme/element-style` — the entry `{ fg?, bg?, attributes? }`.
- `tui-theme/attribute` — one of the eight names accepted in an `attributes`
  array.
- `tui-theme/color-value` — a value of the `fg`/`bg` channels, per the grammar
  of R15.
- `tui-theme/catalog` — the closed set of element names with per-channel
  defaults (Element catalog section).
- `tui-theme/zone` — a catalog group: the set of elements sharing a prefix.
- `tui-theme/palette` — the internal named color layer (legacy v1 key names)
  that catalog defaults and dotless references resolve against.
- `tui-theme/defs` — the named color constants of the theme file's `defs`
  member.
- `tui-theme/migration` — the load-time conversion of a v1 file into the
  internal v2 form.
- `tui-theme/scope` — a tree-sitter highlight scope; scope names are external
  tree-sitter identifiers.
- `tui-theme/selected-foreground` — the computed contrast rule returning the
  foreground over a highlighted surface (R33).
- `tui-theme/tint` — the base + overlay α blend.
- `tui-theme/fade` — the run-CLI α fade derivation over a base color.
- `tui-theme/hover` — pointer hover over an element; the element swaps to
  its hover counterpart (R38).
- `tui-theme/thinking-opacity` — the `thinkingOpacity` scalar multiplying
  reasoning-block foregrounds.
- `tui-theme/vga-table` — the fixed ANSI-index-to-RGBA table (R30); the
  terminal palette is never read for value resolution.

## Interface

- Theme files: `themes/*.json` in the config directory
  (`~/.config/opencode/themes/`) and in `.opencode/themes/` walking up from
  the working directory; discovery, merge priority, and selection (the
  `theme` key of `tui.json`, the theme picker persisted in the TUI KV store)
  are owned by tui-architecture and unchanged by this spec.
- Theme-file shape (v2):

```ts
type Attribute =
  | "bold" | "dim" | "italic" | "underline"
  | "blink" | "inverse" | "hidden" | "strikethrough"

type ColorValue =
  | string            // "#rgb" | "#rgba" | "#rrggbb" | "#rrggbbaa" hex,
                      // "none" | "transparent", or a reference name
  | number            // ANSI index, 0–255
  | { dark: ColorValue; light: ColorValue }

type ElementStyle = {
  fg?: ColorValue
  bg?: ColorValue
  attributes?: Attribute[]
}

type ThemeFileV2 = {
  $schema?: string    // informational; never affects behavior
  defs?: Record<string, ColorValue>   // hex | ANSI | "none" | reference
  theme: Record<string, ElementStyle> & { thinkingOpacity?: number }
}
```

- Reference names: a dotless name matches `^[a-zA-Z][a-zA-Z0-9_-]*$` and
  resolves against `defs` first, then the tui-theme/palette; a dotted name
  must be a catalog element name and resolves channel-wise (R27, R28).
- Load result: a theme file is either accepted (v2), migrated (v1, R21–R24),
  or rejected with exactly one reason code: `PARSE_ERROR` (not valid JSON),
  `NOT_A_THEME` (no `theme` object), `MIXED_FORMATS` (dotted and legacy color
  keys together), `UNKNOWN_ELEMENT`, `UNKNOWN_ATTRIBUTE`, `INVALID_COLOR`
  (malformed hex, ANSI index outside `0`–`255`, or a non-color value),
  `UNRESOLVED_REFERENCE`, `CYCLIC_REFERENCE`, `INVALID_ENTRY` (an
  element-style member outside `fg`/`bg`/`attributes`, or a non-array
  `attributes`).
- Resolved view: `ResolvedElement = { fg: RGBA; bg: RGBA; attributes:
  ReadonlySet<Attribute> }`; a channel with no catalog default resolves to
  the transparent color, an attributes default to the empty set.
- Reactive accessor: the TUI theme context exposes `element(name)` — argument:
  a catalog element name; result: the `ResolvedElement`; error: a thrown
  error when the name is outside the catalog (R42, R43).
- Plugin API: the `TuiTheme` surface gains `element(name)` with the same
  argument contract; the flat legacy projection `current` remains during the
  transition and is deprecated (R45).
- Run CLI: `RunTheme` fields resolve from the `run.*` elements per the run
  zone mapping; the listed derivatives stay computed (R44).

## Configuration

| Name | Allowed values | Default | Effect |
|---|---|---|---|
| `thinkingOpacity` | number 0–1; a non-numeric value falls back to the default without rejection, and a number outside 0–1 is accepted as-is | `0.6` | Multiplier on every reasoning-block foreground and on the subtle-syntax alpha (R36, R37) |
| `ansiToRgba` | fixed table, ANSI index 0–255 → RGBA | — | Resolution of integer color values (R30) |
| `retry-overlay-alpha` | magic 186/255 (nameless literal in the retry dialog) | — | Foreground alpha of `dialog.retry` (catalog) |
| `logo-shadow-alpha` | magic `0.25` (nameless literal in the logo renderer) | — | tui-theme/tint share of `logo.shadow` (R34) |
| `bg-pulse-base-alpha` | magic `0.62` (nameless literal in the bg-pulse renderer) | — | tui-theme/tint share of `bg-pulse.base` (R34) |
| `splash-shadow-alpha` | magic `0.14` (nameless literal in the run splash mapping) | — | tui-theme/tint share of the run splash shadows (R44) |
| `run-footer-shade-fade` | magic fallback `0.12`, scale `0.56`, limit `0.72` (nameless literals in the run footer mapping) | — | tui-theme/fade parameters of the footer `shade` derivative (R44) |
| `run-footer-surface-fade` | magic fallback `0.18`, scale `0.76`, limit `0.9` | — | tui-theme/fade parameters of the footer `surface` derivative (R44) |
| `run-footer-line-fade` | magic fallback `0.24`, scale `0.9`, limit `0.98` | — | tui-theme/fade parameters of the footer `line` derivative (R44) |
| `run-footer-status-tint` | magic shares `0.12`/`0.06` (dark), `0.06`/`0.04` (light), collapse lift `0.7`, accent lift `0.06` (nameless literals) | — | tui-theme/tint parameters of the footer `status`/`statusAccent` derivatives (R44) |
| `luminance-weights` | magic `0.299`, `0.587`, `0.114` (nameless literals in the contrast helpers) | — | Luminance of tui-theme/selected-foreground and of terminal-mode detection (R33) |
| `question-hover-number-tint` | magic `0.6` (nameless literal in the question dialog) | — | tui-theme/tint share of `question.option.hover.number` (R34) |
| `knight-rider-trail` | magic — hardcoded trail shades (nameless literals in the spinner) | — | Spinner easter-egg animation; not themeable (R46) |

## Element catalog

The catalog is closed: exactly the elements listed below are valid
tui-theme/element names (R17). Columns are per-channel defaults. A `—` cell
is the transparent color for colors and the empty set for attributes. A
backticked name is a tui-theme/palette reference. `selected-foreground` is
the computed rule of R33 evaluated against the element's own resolved
background (R32). `tint(...)` marks a computed blend (R34). Border elements
paint single-color strokes on the `fg` channel. Every default reproduces the
rendering its surface had under the pre-v2 implementation (R48); where a live
surface overrides its element with a computed color, the requirements name
the override (R39, R49). Legacy v1 keys not named in
any default cell are dropped by migration (R22): `diffHunkHeader`,
`markdownHorizontalRule`, `markdownListEnumeration`, `markdownImage`,
`markdownImageText`, `markdownCodeBlock`.

### Zone app

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `app.background` | — | `background` | — |

### Zone dialog — shared dialog chrome and generic dialog surfaces

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `dialog.panel` | — | `backgroundPanel` | — |
| `dialog.underlay` | — | `#00000096` | — |
| `dialog.title` | `text` | — | `bold` |
| `dialog.body` | `text` | — | — |
| `dialog.muted` | `textMuted` | — | — |
| `dialog.action` | `selected-foreground` | `primary` | — |
| `dialog.link` | `primary` | — | — |
| `dialog.notice` | `accent` | — | — |
| `dialog.error` | `error` | `backgroundPanel` | — |
| `dialog.retry` | `selected-foreground` | `backgroundPanel` | — |
| `dialog.route.warning` | `warning` | — | — |
| `dialog.route.home` | `text` | `backgroundElement` | — |
| `dialog.session.gutter` | `accent` | — | — |
| `dialog.session.deleted` | — | `error` | — |
| `dialog.changes.list` | — | `backgroundElement` | — |
| `dialog.changes.added` | `diffAdded` | — | — |
| `dialog.changes.removed` | `diffRemoved` | — | — |
| `dialog.console.email` | `accent` | — | — |
| `dialog.plugins.active` | `success` | — | — |
| `dialog.plugins.inactive` | `error` | — | — |
| `dialog.mcp.enabled` | `success` | — | — |
| `dialog.provider.connected` | `success` | — | — |
| `dialog.status.ok` | `success` | — | — |
| `dialog.status.warn` | `warning` | — | — |
| `dialog.status.error` | `error` | — | — |
| `dialog.debug.copied` | `success` | — | — |
| `dialog.export.option` | `text` | — | — |
| `dialog.export.option.active` | `primary` | `backgroundElement` | — |
| `dialog.prompt.cursor.busy` | `backgroundElement` | — | — |

### Zone dialog.select — list/filter dialogs (DialogSelect and equivalents)

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `dialog.select.filter` | `textMuted` | `backgroundPanel` | — |
| `dialog.select.filter.cursor` | `primary` | — | — |
| `dialog.select.row` | `text` | — | — |
| `dialog.select.row.selected` | `selected-foreground` | `primary` | `bold` |
| `dialog.select.row.selected.unfocused` | `textMuted` | `backgroundElement` | — |
| `dialog.select.category` | `accent` | — | `bold` |
| `dialog.select.footer` | `text` | — | — |
| `dialog.select.footer.label` | `textMuted` | — | — |
| `dialog.select.footer.active` | `selected-foreground` | `primary` | `bold` |
| `dialog.select.footer.disabled` | `textMuted` | — | — |
| `dialog.select.marker` | `primary` | — | — |

### Zone autocomplete — prompt autocomplete menu

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `autocomplete.menu` | — | `backgroundMenu` | — |
| `autocomplete.menu.border` | `border` | — | — |
| `autocomplete.row` | `text` | — | — |
| `autocomplete.row.selected` | `selected-foreground` | `primary` | — |
| `autocomplete.muted` | `textMuted` | — | — |

### Zone prompt — editor, placeholders, chips, extmarks

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `prompt.container` | — | `backgroundElement` | — |
| `prompt.container.border` | `border` | — | — |
| `prompt.shell.border` | `primary` | — | — |
| `prompt.text` | `text` | — | — |
| `prompt.placeholder` | `textMuted` | — | — |
| `prompt.cursor` | `text` | — | — |
| `prompt.cursor.disabled` | — | `backgroundElement` | — |
| `prompt.notice` | `accent` | — | — |
| `prompt.chip` | `text` | `backgroundElement` | — |
| `prompt.meta` | `textMuted` | — | — |
| `prompt.retry` | `error` | — | — |
| `prompt.interrupt` | `primary` | — | — |
| `prompt.editor.pending` | `secondary` | — | — |
| `prompt.extmark.file` | `warning` | — | `bold` |
| `prompt.extmark.agent` | `secondary` | — | `bold` |
| `prompt.extmark.paste` | `selected-foreground` | `warning` | `bold` |

### Zone message — transcript messages per role

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `message.user.body` | `text` | `backgroundPanel` | — |
| `message.user.body.hover` | `text` | `backgroundElement` | — |
| `message.user.badge` | `selected-foreground` | `secondary` | — |
| `message.user.file` | `textMuted` | `backgroundElement` | — |
| `message.assistant.body` | `text` | — | — |
| `message.assistant.meta` | `textMuted` | — | — |
| `message.assistant.meta.mode` | `text` | — | — |
| `message.assistant.meta.variant` | `warning` | — | `bold` |
| `message.system.body` | `textMuted` | — | — |
| `message.reasoning.header` | `warning` | — | — |
| `message.reasoning.body` | `textMuted` | — | — |
| `message.tool.card` | — | `backgroundPanel` | — |
| `message.tool.card.hover` | — | `backgroundMenu` | — |
| `message.tool.card.border` | `background` | — | — |
| `message.tool.gutter` | `textMuted` | — | — |
| `message.tool.header` | `textMuted` | — | — |
| `message.tool.body` | `text` | — | — |
| `message.tool.body.pending` | `textMuted` | — | — |
| `message.tool.status.pending` | `warning` | — | — |
| `message.tool.status.error` | `error` | — | — |
| `message.tool.status.done` | `textMuted` | — | — |
| `message.tool.args.denied` | `text` | — | `strikethrough` |
| `message.error.panel` | — | `backgroundPanel` | — |
| `message.error.border` | `error` | — | — |
| `message.error.body` | `textMuted` | — | — |
| `message.revert` | `textMuted` | `backgroundPanel` | — |
| `message.revert.hover` | `textMuted` | `backgroundElement` | — |
| `message.queued` | `textMuted` | — | `bold` |
| `message.timestamp` | `textMuted` | — | — |
| `message.compaction` | `borderActive` | — | — |

### Zone footer — session footer strip

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `footer.panel` | — | `backgroundPanel` | — |
| `footer.text` | `text` | — | — |
| `footer.muted` | `textMuted` | — | — |
| `footer.permission` | `warning` | — | — |
| `footer.status.ok` | `success` | — | — |
| `footer.status.warn` | `warning` | — | — |
| `footer.status.error` | `error` | — | — |

### Zone sidebar — sidebar panel and its feature sections

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `sidebar.panel` | — | `backgroundPanel` | — |
| `sidebar.dim` | — | `#00000046` | — |
| `sidebar.text` | `text` | — | — |
| `sidebar.muted` | `textMuted` | — | — |
| `sidebar.strong` | `text` | — | `bold` |
| `sidebar.emphasized` | `text` | — | `italic` |
| `sidebar.item.open` | `success` | — | — |
| `sidebar.status.ok` | `success` | — | — |
| `sidebar.status.warn` | `warning` | — | — |
| `sidebar.status.error` | `error` | — | — |
| `sidebar.todo.pending` | `warning` | — | — |
| `sidebar.getting-started` | — | `backgroundElement` | — |
| `sidebar.files.added` | `diffAdded` | — | — |
| `sidebar.files.removed` | `diffRemoved` | — | — |

### Zone scrollbar — shared scrollbars

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `scrollbar.track` | — | `backgroundElement` | — |
| `scrollbar.track.overlay` | — | `background` | — |
| `scrollbar.thumb` | `border` | — | — |
| `scrollbar.thumb.active` | `borderActive` | — | — |

### Zone diff — diff viewer, permission diff bodies, diff banners

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `diff.text` | `text` | — | — |
| `diff.border` | `border` | — | — |
| `diff.line.added` | `text` | `diffAddedBg` | — |
| `diff.line.removed` | `text` | `diffRemovedBg` | — |
| `diff.line.context` | `text` | `diffContextBg` | — |
| `diff.sign.added` | `diffHighlightAdded` | — | — |
| `diff.sign.removed` | `diffHighlightRemoved` | — | — |
| `diff.gutter` | `diffLineNumber` | `diffContextBg` | — |
| `diff.gutter.added` | `diffLineNumber` | `diffAddedLineNumberBg` | — |
| `diff.gutter.removed` | `diffLineNumber` | `diffRemovedLineNumberBg` | — |
| `diff.banner.added` | `diffAdded` | — | — |
| `diff.banner.removed` | `diffRemoved` | — | — |
| `diff.filetree.row` | `textMuted` | — | — |
| `diff.filetree.row.selected` | `background` | `primary` | — |
| `diff.filetree.row.selected.name` | `primary` | — | — |

### Zone markdown — markdown rendering (scope-driven)

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `markdown.text` | `markdownText` | — | — |
| `markdown.bg` | — | `background` | — |
| `markdown.heading` | `markdownHeading` | — | `bold` |
| `markdown.heading.h1` | `markdownHeading` | — | `bold`, `underline` |
| `markdown.strong` | `markdownStrong` | — | `bold` |
| `markdown.emph` | `markdownEmph` | — | `italic` |
| `markdown.quote` | `markdownBlockQuote` | — | `italic` |
| `markdown.list` | `markdownListItem` | — | — |
| `markdown.code.inline` | `markdownCode` | `background` | — |
| `markdown.code.block` | `markdownCode` | — | — |
| `markdown.link` | `markdownLink` | — | `underline` |
| `markdown.link.label` | `markdownLinkText` | — | `underline` |
| `markdown.label` | `markdownLinkText` | — | — |
| `markdown.underline` | `text` | — | `underline` |

### Zone syntax — code highlighting (scope-driven)

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `syntax.default` | `text` | — | — |
| `syntax.comment` | `syntaxComment` | — | `italic` |
| `syntax.keyword` | `syntaxKeyword` | — | `italic` |
| `syntax.keyword.import` | `syntaxKeyword` | — | — |
| `syntax.escape` | `syntaxKeyword` | — | — |
| `syntax.tag.attribute` | `syntaxKeyword` | — | — |
| `syntax.string` | `syntaxString` | — | — |
| `syntax.number` | `syntaxNumber` | — | — |
| `syntax.type` | `syntaxType` | — | — |
| `syntax.type.definition` | `syntaxType` | — | `bold` |
| `syntax.type.keyword` | `syntaxType` | — | `bold`, `italic` |
| `syntax.function` | `syntaxFunction` | — | — |
| `syntax.variable` | `syntaxVariable` | — | — |
| `syntax.operator` | `syntaxOperator` | — | — |
| `syntax.punctuation` | `syntaxPunctuation` | — | — |
| `syntax.error` | `error` | — | — |
| `syntax.error.strong` | `error` | — | `bold` |
| `syntax.comment.error` | `error` | — | `italic`, `bold` |
| `syntax.warning` | `warning` | — | — |
| `syntax.warning.strong` | `warning` | — | `bold` |
| `syntax.comment.warning` | `warning` | — | `italic`, `bold` |
| `syntax.todo` | `info` | — | — |
| `syntax.comment.todo` | `info` | — | `italic`, `bold` |
| `syntax.checked` | `success` | — | — |
| `syntax.conceal` | `textMuted` | — | — |
| `syntax.prompt` | `accent` | — | — |
| `syntax.diff.plus` | `diffAdded` | `diffAddedBg` | — |
| `syntax.diff.minus` | `diffRemoved` | `diffRemovedBg` | — |
| `syntax.diff.delta` | `diffContext` | `diffContextBg` | — |

### Zone toast

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `toast.panel` | — | `backgroundPanel` | — |
| `toast.title` | `text` | — | `bold` |
| `toast.body` | `text` | — | — |
| `toast.error.border` | `error` | — | — |
| `toast.info.border` | `info` | — | — |
| `toast.success.border` | `success` | — | — |
| `toast.warning.border` | `warning` | — | — |

### Zone permission — permission prompt

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `permission.panel` | — | `backgroundPanel` | — |
| `permission.border` | `warning` | — | — |
| `permission.border.reject` | `error` | — | — |
| `permission.marker` | `warning` | — | — |
| `permission.marker.reject` | `error` | — | — |
| `permission.option` | `textMuted` | `backgroundMenu` | — |
| `permission.option.selected` | `selected-foreground` | `warning` | — |
| `permission.caption` | `textMuted` | — | — |
| `permission.bar` | — | `backgroundElement` | — |
| `permission.body` | `text` | — | — |
| `permission.text` | `text` | — | — |
| `permission.text.cursor` | `primary` | — | — |

### Zone question — question dialog

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `question.panel` | — | `backgroundPanel` | — |
| `question.border` | `accent` | — | — |
| `question.tab` | `text` | `backgroundPanel` | — |
| `question.tab.active` | `selected-foreground` | `accent` | — |
| `question.tab.hover` | `text` | `backgroundElement` | — |
| `question.option` | `text` | `backgroundPanel` | — |
| `question.option.hover` | `secondary` | `backgroundElement` | — |
| `question.option.hover.number` | `tint(textMuted, secondary, question-hover-number-tint)` | `backgroundElement` | — |
| `question.option.selected` | `selected-foreground` | `secondary` | — |
| `question.option.picked` | `success` | — | — |
| `question.muted` | `textMuted` | — | — |
| `question.unanswered` | `error` | — | — |
| `question.body` | `text` | — | — |
| `question.review` | `text` | — | — |
| `question.text` | `text` | — | — |
| `question.text.cursor` | `primary` | — | — |
| `question.hint` | `text` | — | — |

### Zone subagent — subagent footer bar

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `subagent.footer.panel` | — | `backgroundPanel` | — |
| `subagent.footer.border` | `border` | — | — |
| `subagent.footer.text` | `text` | — | — |
| `subagent.footer.strong` | `text` | — | `bold` |
| `subagent.footer.muted` | `textMuted` | — | — |
| `subagent.footer.hover` | `text` | `backgroundElement` | — |

### Zone which-key — which-key overlay

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `which-key.panel` | — | `backgroundMenu` | — |
| `which-key.text` | `text` | — | — |
| `which-key.muted` | `textMuted` | — | — |
| `which-key.key` | `warning` | — | — |
| `which-key.subtle` | `borderSubtle` | — | — |
| `which-key.tab` | `selectedListItemText` | — | — |
| `which-key.accent` | `primary` | — | — |

### Zone startup — startup loading box

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `startup.panel` | — | `backgroundPanel` | — |
| `startup.loading` | `textMuted` | — | — |

### Zone logo — startup logo

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `logo.left` | `textMuted` | — | — |
| `logo.right` | `text` | — | `bold` |
| `logo.shadow` | — | `tint(background, element fg, logo-shadow-alpha)` | — |

### Zone bg-pulse — background pulse animation

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `bg-pulse.panel` | — | `backgroundPanel` | — |
| `bg-pulse.accent` | `primary` | — | — |
| `bg-pulse.base` | — | `tint(background, text, bg-pulse-base-alpha)` | — |

### Zone tips — home tips

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `tips.marker` | `warning` | — | — |

### Zone run — run CLI (scrollback, footer, splash)

| Element | fg default | bg default | attributes default |
|---|---|---|---|
| `run.background` | — | `background` | — |
| `run.footer.text` | `text` | — | — |
| `run.footer.muted` | `textMuted` | — | — |
| `run.footer.highlight` | `primary` | — | — |
| `run.footer.warn` | `warning` | — | — |
| `run.footer.success` | `success` | — | — |
| `run.footer.error` | `error` | — | — |
| `run.footer.selected` | — | `backgroundElement` | — |
| `run.footer.selected-text` | `selectedListItemText` | — | — |
| `run.footer.pane` | — | `backgroundMenu` | — |
| `run.footer.border` | `border` | — | — |
| `run.entry.system` | `textMuted` | — | — |
| `run.entry.user` | `primary` | — | — |
| `run.entry.assistant` | `text` | — | — |
| `run.entry.reasoning` | `textMuted` | — | — |
| `run.entry.tool` | `text` | — | — |
| `run.entry.tool.start` | `textMuted` | — | — |
| `run.entry.error` | `error` | — | — |
| `run.splash.left` | `textMuted` | — | — |
| `run.splash.right` | `text` | — | — |
| `run.block.highlight` | `primary` | — | — |
| `run.block.warning` | `warning` | — | — |
| `run.block.text` | `text` | — | — |
| `run.block.muted` | `textMuted` | — | — |
| `run.block.diff.added` | `diffAdded` | — | — |
| `run.block.diff.removed` | `diffRemoved` | — | — |
| `run.block.diff.added-bg` | — | — | — |
| `run.block.diff.removed-bg` | — | — | — |
| `run.block.diff.context-bg` | — | — | — |
| `run.block.diff.highlight-added` | `diffHighlightAdded` | — | — |
| `run.block.diff.highlight-removed` | `diffHighlightRemoved` | — | — |
| `run.block.diff.line-number` | `diffLineNumber` | — | — |
| `run.block.diff.added-line-number-bg` | — | `diffAddedLineNumberBg` | — |
| `run.block.diff.removed-line-number-bg` | — | `diffRemovedLineNumberBg` | — |

Run-zone derivatives stay computed and carry no elements: the footer
`status`, `statusAccent`, `shade`, `surface`, and `line` fields are
tui-theme/tint or tui-theme/fade derivations of `run.footer.pane`,
`run.background`, and the footer mode with the Configuration constants; the
splash `leftShadow`/`rightShadow` fields are tui-theme/tint derivations of
the splash colors with `splash-shadow-alpha`. The run block diff RunTheme
fields (`diffAdded`, `diffRemoved`, `diffAddedBg`, `diffRemovedBg`,
`diffContextBg`, `diffHighlightAdded`, `diffHighlightRemoved`,
`diffLineNumber`, `diffAddedLineNumberBg`, `diffRemovedLineNumberBg`)
resolve from the `run.block.diff.*` elements above, whose defaults are
byte-identical to the base run rendering (R48): the base pinned the added,
removed, and context backgrounds transparent and took the foregrounds and
the line-number backgrounds from the palette, so exactly those carry
palette defaults. The run diff background elements stay addressable in both
directions (R44): a theme may set one to the transparent color
(`{"bg": "transparent"}`) or paint one through a palette reference
(`"diffAddedBg"`). RunTheme field names are fixed run-CLI
surface names and are distinct from element names: the footer
`selectedText` field is the projection of `run.footer.selected-text`, not an
element of its own.

## Requirements

- R13. A tui-theme/theme-file in the v2 format is a JSON object whose only top-level members are the optional `$schema` and `defs` and the required `theme`, and whose `theme` maps tui-theme/element names to tui-theme/element-style entries.
- R14. A tui-theme/element-style is an object whose only permitted members are the optional `fg`, `bg`, and `attributes`, and any other member makes the file invalid.
- R15. A tui-theme/color-value is exactly one of the following forms: a hexadecimal color string of three, four, six, or eight hex digits; an integer ANSI index within the bounds declared in Interface; the string `none` or `transparent`; a reference name; or a `{dark, light}` variant object holding a color value of any form in each arm.
- R16. A tui-theme/attribute is exactly one of the eight names enumerated in Interface, and any other name in an `attributes` array makes the file invalid.
- R17. A tui-theme/element name is a dot-separated string whose segments consist of lowercase letters, digits, and hyphens and start with a letter, and a name that the tui-theme/catalog does not contain makes the file invalid.
- R18. A theme file whose `theme` object contains at least one dotted key is treated as v2, and a file whose `theme` object contains no dotted key is treated as v1.
- R19. A v2 file whose `theme` object also contains a legacy v1 color key makes the file invalid, and the scalar `thinkingOpacity` is the only non-element key a v2 `theme` object may carry.
- R20. `thinkingOpacity` is accepted as a scalar of `theme` in both formats and is never addressable through an element entry.
- R21. Every v1 theme source — the built-in theme files, discovered user files, plugin-installed themes, and the generated `system` theme — is migrated to the internal v2 form at load before resolution, and v1 files on disk are never rewritten.
- R22. tui-theme/migration reads the live legacy keys of the file into the tui-theme/palette, applies the palette fallbacks `selectedListItemText` to `background` and `backgroundMenu` to `backgroundElement`, ignores the dropped legacy keys without error, and carries `thinkingOpacity` through unchanged.
- R23. tui-theme/migration is lossless for rendered output: after migration, every catalog element resolves to the color and attributes its rendered surface had before migration.
- R24. For a native v2 file the tui-theme/palette is the resolved palette of the default built-in theme, and a palette name missing from a v1 file falls back to the same source.
- R25. A channel of an element entry wins over the catalog default of that channel.
- R26. A partial element entry leaves its unset channels at the catalog defaults, and a present `attributes` array replaces the default attribute set wholesale.
- R27. A dotless reference name resolves against `defs` first and then the tui-theme/palette, a dotted reference name resolves against the referenced element, and an unresolvable reference makes the file invalid.
- R28. An element reference is channel-wise: an `fg` reference takes the referenced element's resolved foreground, a `bg` reference takes its resolved background, and attributes never flow through a reference.
- R29. A reference chain that revisits a name makes the file invalid.
- R30. An integer ANSI index resolves through the fixed tui-theme/vga-table, and the live terminal palette is never read for color-value resolution.
- R31. A `{dark, light}` variant resolves to the arm selected by the active mode.
- R32. A catalog default citing the computed tui-theme/selected-foreground rule is evaluated against the resolved background of the same element.
- R33. tui-theme/selected-foreground returns the palette `selectedListItemText` when it is explicitly set; otherwise it returns black or white by the luminance of the given background when the palette `background` is transparent; otherwise it returns the palette `background`.
- R34. The tui-theme/tint and tui-theme/fade blends stay computed derivations of resolved colors, with their fixed shares recorded in Configuration.
- R35. The application root is painted from the background of `app.background`.
- R36. `thinkingOpacity` multiplies every foreground of the reasoning block, the header included.
- R37. The reasoning body is rendered with the subtle syntax rules whose foreground alpha is multiplied by `thinkingOpacity`.
- R38. Pointer hover swaps every channel of an element for its hover counterpart from the tui-theme/catalog: a `.hover` variant, or the `message.tool.body.pending` to `message.tool.body` pair.
- R39. Agent dot colors stay computed: the rotation over `secondary`, `accent`, `success`, `warning`, `primary`, `error`, `info` cycles by agent index starting at `secondary`, and an agent `color` naming a hexadecimal string or a palette name overrides the rotation.
- R40. Syntax and markdown rendering take the foreground and the attributes of each scope rule from the corresponding `syntax.*` or `markdown.*` element.
- R41. The scope `default` resolves to `syntax.default`.
- R42. The TUI theme context exposes a reactive accessor `element(name)` returning the resolved foreground, background, and attribute set of the named element, and reads through it re-evaluate when the theme or the mode changes.
- R43. `element(name)` with a name outside the tui-theme/catalog throws an error.
- R44. The run CLI derives every RunTheme color field from the resolved `run.*` elements, keeps the computed derivatives of the run zone, and resolves through the shared pipeline instead of a private copy of the theme resolver. The `run.block.diff.added-bg`, `run.block.diff.removed-bg`, and `run.block.diff.context-bg` defaults are the transparent color, and a theme entry on any of them may set either the transparent color or a reference such as the palette name `diffAddedBg`.
- R45. The plugin theme API exposes `element(name)` with the same argument contract, and keeps the flat legacy projection `current` available and deprecated during the transition.
- R46. The crash error-component palette and the Knight-Rider spinner trail stay outside the theme and are not addressable by elements.
- R47. A rejected theme file is dropped at load with its reason surfaced to the user, and the active theme falls back to the default built-in theme.
- R48. With the default built-in theme, every tui-theme/catalog default and every element-sourced syntax or markdown rule resolves to exactly the foreground, background, and attribute set the same surface rendered under the pre-v2 implementation.
- R49. The queued message chip takes its attribute set and its resting foreground from `message.queued`. While the computed agent color of R39 is available, the chip paints that color as its background and tui-theme/selected-foreground over it as its foreground.

## Examples

- A15. Valid color values: `#f0f`, `#8015`, `#2eff6a`, `#00000096`, `160`, `"none"`, `"transparent"`, `"ink"` (a defs or palette name), `{"dark": "ink", "light": "#f5f5f5"}`. Invalid: `#ff00f` (five digits), `256` (out of ANSI bounds), `{"dark": "ink"}` (missing arm).
- A18. Discrimination: a file whose `theme` holds only legacy keys like `primary` and `textMuted` is v1; a file whose `theme` holds `"dialog.title"` is v2; a file whose `theme` holds both `"text"` and `"dialog.title"` is rejected as mixed.
- A21. Every built-in theme file under `packages/tui/src/theme/assets/` loads through migration without any change to the files on disk.
- A22. A v1 file that sets only `primary` and `background` migrates so that every element defaulting to `primary` takes the file's value, while the remaining palette names fall back to the default built-in theme.
- A26. `{"fg": "#ff0000"}` on `dialog.title` keeps the background transparent and the attributes `bold`.
- A27. In a file with `"defs": {"ink": "#101010"}`, the entry `{"fg": "ink"}` resolves `defs` first; `{"bg": "primary"}` resolves the palette; `{"fg": "dialog.title"}` takes the resolved foreground of `dialog.title`.
- A38. Pointer hover over a tool card swaps `message.tool.card` for `message.tool.card.hover`; the InlineTool foreground pair swaps `message.tool.body.pending` for `message.tool.body`.

## Justification

- J1. Why format discrimination is the dotted-key test (R18): every legacy color key is a single camelCase word containing no dot, every v2 element name contains a dot, so the test is total and mechanical without adding a format version field.
- J2. Why mixed files are rejected instead of partially honored (R19, R47): silently ignoring one dialect would hide authoring mistakes, and migration already covers every legitimate v1 use.
- J3. Why the dropped legacy keys are removed from the palette instead of mapped (R22, R23): they never reached a rendered surface, so dropping them preserves rendered output while shrinking the new format and preventing a new generation of dangling keys.
- J4. Why native v2 files inherit the default built-in theme's palette (R24): catalog defaults are written as palette references, so a partial v2 theme must resolve them against a concrete palette, and the default built-in theme is the same source the loader already falls back to.
- J5. Why a present `attributes` array replaces the default set instead of merging (R26): merging would make removing a default attribute impossible to express in a partial entry.
- J6. Why tui-theme/selected-foreground stays computed and `selectedListItemText` stays a palette name (R32, R33): the rule is contrast logic over arbitrary selection backgrounds, which a static color channel cannot express, while the palette name remains the explicit override v1 authors already use.
- J7. Why border surfaces are dedicated `.border` elements painting on the `fg` channel (Element catalog): the entry shape is fixed to `fg`/`bg`/`attributes`, and a border is a single-color stroke, so a separate element keeps both fill and border addressable.
- J8. Why the attribute enum is exactly the @opentui/core `TextAttributes` set (R16): the renderer can only apply the attributes it defines, so a wider set would create dead keys and a narrower set would lose renderable states.
- J9. Why `thinkingOpacity` stays a scalar instead of per-element alpha (R20, R36): one global multiplier matches the single knob that exists today and avoids duplicating it across every reasoning element.
- J10. Why unknown element names are rejected at load (R17, R47): a closed catalog turns typos into load errors instead of silently unstyled surfaces.
- J11. Why the run block diff fields resolve from dedicated `run.block.diff.*` elements (R44): the run diff surfaces must stay element-addressable so a theme can clear one (`{"bg": "transparent"}`) or paint one through a palette reference (`{"bg": "diffAddedBg"}`), the base pinned the added, removed, and context backgrounds transparent and took the foregrounds and the line-number backgrounds from the palette, so those defaults keep the default rendering byte-identical to base, and the no-terminal-palette fallback keeps its bespoke seed derivation outside the element path.
- J12. Why default-theme byte-identity is binding for catalog defaults and element-sourced rules (R48): the element format is a re-addressing of the existing rendering rather than a restyling, so any normalization delta between the pre-v2 hardcoded styles and the catalog is a migration defect rather than a design choice, which extends the R23 losslessness promise from the palette to the rule layer.
- J13. Why the home footer consumes the `footer.*` zone (Element catalog): the home footer strip renders the same footer surface as the session footer, so reusing the zone keeps one addressable surface with lossless defaults instead of duplicating identical rows.
- J14. Why the dialog status dots share one `dialog.status.*` trio across dialogs (Element catalog): status dots render the same ok, warn, and error semantics wherever a dialog shows them, so one shared trio keeps the defaults identical to the flat reads it replaces while `sidebar.status.*` stays separate for independent tuning of the sidebar.

## Error handling

All load rejections share one semantics: the file is excluded from the theme
registry, the reason code is surfaced to the user, and the active theme falls
back to the default built-in theme (R47); no partial application of a
rejected file ever renders. Rejection classes: malformed payload
(`PARSE_ERROR`, `NOT_A_THEME`) — not retryable, corrected only by fixing the
file; format violations (`MIXED_FORMATS`, `INVALID_ENTRY`,
`UNKNOWN_ELEMENT`, `UNKNOWN_ATTRIBUTE`, `INVALID_COLOR`) — not retryable, the
author must conform to the catalog and grammar; reference violations
(`UNRESOLVED_REFERENCE`, `CYCLIC_REFERENCE`) — not retryable, the author must
fix the reference graph. `element(name)` with a non-catalog name is a
programming error and throws at the call site (R43); it is never a load
rejection.

## Dependencies

- tui-plugins — the plugin theme API mount point (`api.theme`) that the
  element accessor of R45 extends.

## Used by

- tui-architecture — theme resolution and element mapping for the TUI
  runtime (referenced there, not restated).
- app-desktop-cli — boundary statement: the terminal theme engine (this
  spec) and the web/desktop theme system are separate engines; neither
  consumes the other.
