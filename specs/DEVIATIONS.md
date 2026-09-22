# Specification Deviations

## D-2 2026-09-22 specs/discard-context.md, specs/tui-theme.md
Spec edit: R10 (transcript visual state) added — every part whose id is in
  the marked union renders its primary text through `message.discarded.text`
  with a sentinel block background; tui-theme gains the
  `message.discarded.*` and `sidebar.discard.*` elements (R51 through R54;
  the catalog grows to `280` elements in `23` zones), the
  tui-theme/dimmed-palette ColorDefault variant, and the `discarded-alpha`
  Configuration constant.
Was: the TUI renders marked parts with no special styling at all — the
  render path `packages/tui/src/routes/session/index.tsx` never consults the
  marked-id set; `collectDiscardedPartIds`
  (`packages/tui/src/util/discard-context.ts`) feeds only the marker label,
  the token total, the export, and the sidebar stats; the discard marker
  line borrows the shared `message.tool.body.pending` /
  `message.tool.body` / `message.tool.status.error` reads through
  `InlineTool`; the sidebar discard block flat-reads
  `theme.current.text` / `theme.current.textMuted`.
Now: marked parts render in the discarded style (`message.discarded.text`
  foreground and attributes on the primary text of every part type, sentinel
  block background per tui-theme R51.2); the marker trio takes
  `message.discarded.marker` / `.pending` / `.error`; the sidebar block
  takes `sidebar.discard.header` / `sidebar.discard.row`.
Code impact: `packages/tui/src/theme/catalog.ts` (six new rows and the
  `dimmed-palette` ColorDefault variant with `discarded-alpha`), the theme
  resolver, the session route's part renderers (marked-id set plumbed to
  user text and file badges, assistant text, reasoning bodies, and tool
  card primary text), the `DiscardContext` marker component in
  `packages/tui/src/routes/session/index.tsx`, and
  `packages/tui/src/feature-plugins/sidebar/discard-stats.tsx`; schema and
  catalog tables under `packages/web/public/theme.json` and
  `packages/web/src/content/docs/themes.mdx` with its translations.
Tests: new coverage for the discarded-block styling per part type, the
  sentinel background, the marker trio, and the sidebar elements; the
  existing discard tests keep passing (no color assertions exist in them).
Review focus: unmarked parts render byte-identically under the default
  built-in theme; the marker trio and the sidebar block render exactly as
  before the elements; marked ids never appear; tool state colors keep
  their own elements; a theme-set background on `message.discarded.text`
  repaints discarded blocks only.
