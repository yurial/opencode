# Specification Deviations

## D-1 2026-09-22 specs/tui-theme.md
Spec edit: R39 rewritten as the R39.1–R39.6 group — the agent color rotation
  now cycles the new `agent.color.one`…`agent.color.seven` elements (new
  `agent` zone; the catalog grows to `274` elements in `23` zones), and the
  agent `color` configuration override gains the catalog-element name path
  (precedence: hex, then element name, then palette name). R49 now sources
  the queued chip background from the rotation per R39.
Was: the rotation reads the flat palette (`theme.secondary` through
  `theme.info`) in `packages/tui/src/context/local.tsx` (`colors()` and
  `color()`); an agent `color` override resolves a hexadecimal string or a
  palette name only; the QUEUED chip background and the user-message left
  border paint that flat-palette color, so for a native v2 file — whose
  palette is the default built-in theme's (R24) — these surfaces cannot be
  recolored by the theme at all.
Now: the rotation cycles the resolved foregrounds of `agent.color.one`
  through `agent.color.seven` by visible-agent index; the override resolves
  a hexadecimal string literally, a catalog element name to that element's
  foreground, or a palette name for v1 compatibility; every agent-colored
  surface (dot, user-message left border, assistant mode marker, queued
  chip background) takes the element-sourced color.
Code impact: `packages/tui/src/theme/catalog.ts` (seven new `agent.color.*`
  rows), `packages/tui/src/context/local.tsx` (rotation and override
  resolution through `element()`), `packages/core/src/v1/config/agent.ts`
  (accept element-name `color` values), `packages/web/public/theme.json`
  and `packages/web/src/content/docs/themes.mdx` with its translations (new
  elements in the schema and the catalog tables).
Tests: `packages/tui/test/theme-v2.test.ts` (catalog coverage);
  `packages/opencode/test/config/agent-color.test.ts` (override paths: hex,
  element name, palette name).
Review focus: byte-identity of the rendered rotation for the default
  built-in theme and for migrated v1 files; a v2 file recolors the rotation
  through `agent.color.*`; override precedence hex over element name over
  palette name.
