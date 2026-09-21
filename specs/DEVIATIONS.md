# Specification Deviations

## D-1 2026-09-20 specs/tui-theme.md
Spec edit: spec rewritten for theme format v2 — per-element entries, catalog
  with defaults, v1 migration, resolution, error semantics (R13–R34, R47);
  retires requirements R1–R12 and mapping tables T1–T12 of the previous
  revision.
Was: one flat set of legacy camelCase color keys resolved to a flat RGBA map
  with no attributes channel; six legacy keys dangling; mixed and unknown
  keys unvalidated at load.
Now: dotted element entries carrying `fg`/`bg`/`attributes`; v1 files
  auto-migrated at load, lossless for rendered output; mixed files and
  unknown elements, attributes, colors, or references rejected at load with
  fallback to the default built-in theme.
Code impact: packages/tui/src/theme/index.ts (catalog constants, default
  table, v2 resolver, migration, load validation), packages/tui/src/context/theme.tsx
  (load path, rejection fallback), packages/tui/src/theme/assets/*.json stay
  v1 files going through migration.
Tests: resolver, migration, format-discrimination, and error suites to be
  authored; all built-in themes must load through the migration.
Review focus: a migrated v1 theme renders identically to the current build;
  palette fallbacks (selectedListItemText, backgroundMenu, missing keys to
  the default theme); rejection paths surface reason codes.

## D-2 2026-09-20 specs/tui-theme.md
Spec edit: element catalog defaults and the consumption contract
  (R35–R43) replace flat-key reads and hardcoded text styles.
Was: roughly forty-five component files read the flat map via `useTheme()` and hardcode
  text attributes (`TextAttributes` props, inline style bold, `<b>`/`<i>`
  tags); which-key renames theme keys into a local fallback skin.
Now: components consume `element(name)` per the catalog; attributes come
  from the catalog and theme; hover counterparts wired; border strokes on
  `.border` elements.
Code impact: packages/tui/src/ui/dialog-*.tsx, ui/toast.tsx,
  component/prompt/index.tsx, component/prompt/autocomplete.tsx,
  routes/session/index.tsx, routes/session/footer.tsx, routes/session/permission.tsx,
  routes/session/question.tsx, routes/session/sidebar.tsx, routes/session/subagent-footer.tsx,
  component/logo.tsx, component/bg-pulse.tsx, component/startup-loading.tsx,
  component/todo-item.tsx, component/dialog-*.tsx, feature-plugins/home/*,
  feature-plugins/sidebar/*, feature-plugins/system/* (which-key.tsx,
  diff-viewer*, plugins.tsx), packages/tui/src/context/theme.tsx (accessor).
Tests: component snapshots to be updated with the catalog defaults.
Review focus: every hardcoded attribute site mapped to a catalog default;
  hover pairs swap all channels; crash error-component palette stays
  outside the theme.

## D-4 2026-09-20 specs/tui-theme.md
Spec edit: plugin API consumption (R45) — element access on the plugin
  theme surface.
Was: TuiThemeCurrent mirrors the flat resolved map; TuiTheme exposes no
  element access.
Now: `element(name)` on the plugin theme API with the spec contract; the
  flat `current` projection remains available and deprecated.
Code impact: packages/plugin/src/tui.ts, packages/tui/src/plugin/adapters.tsx,
  packages/tui/src/plugin/slots.tsx (theme context handed to slot plugins).
Tests: plugin API type tests to be extended with the accessor.
Review focus: accessor contract matches the spec; existing plugins reading
  `current` keep working.

## D-5 2026-09-20 specs/tui-theme.md
Spec edit: v2 file shape fixed (R13–R20, Interface) and the element catalog
  made the authoring surface.
Was: packages/web/public/theme.json publishes the v1 flat-key schema;
  themes.mdx (en plus locale copies) documents only v1 keys.
Now: the published schema describes v2 element entries with v1 described as
  deprecated and auto-migrated; documentation updated to the catalog.
Code impact: packages/web/public/theme.json, packages/web/src/content/docs/themes.mdx
  and its locale copies.
Tests: schema fixtures for valid v2, valid v1, and mixed files.
Review focus: schema rejects unknown members consistent with the spec's
  invalid-entry behavior; docs enumerate the catalog reference.

## D-7 2026-09-21 specs/tui-theme.md
Spec edit: run diff background defaults corrected to the base rendering —
  `run.block.diff.added-bg`, `run.block.diff.removed-bg`, and
  `run.block.diff.context-bg` default to the transparent color (R44
  extended, run zone of the Element catalog, J11 restated);
  `thinkingOpacity` soft handling documented (Configuration row); supersedes
  entry `D-6`, whose `Now` cited palette diff names for the run diff
  backgrounds that the corrected catalog no longer prescribes.
Was: the code resolves the three run diff backgrounds from the palette
  diff names — the catalog defaults paint `diffAddedBg`, `diffRemovedBg`,
  and `diffContextBg` opaque on the default theme, the run theme goldens
  assert those opaque values, and the generated-system test skips the
  three background assertions.
Now: the spec prescribes transparent defaults for the three run diff
  backgrounds, byte-identical to the base run rendering (R48), with both
  directions addressable — the transparent value or a palette reference.
Code impact: packages/tui/src/theme/catalog.ts (the three `run.block.diff.*`
  background defaults), packages/opencode/test/cli/run/theme-v2.test.ts
  (the goldens and element-path equality asserts for the three
  backgrounds, the skipped generated-system assertions).
Tests: the v1-defaults golden test and the element-path equality test drop
  the palette expectation for the three backgrounds; the generated-system
  test asserts them transparent; the override test keeps both directions
  (a palette reference paints, the transparent value clears).
Review focus: default-theme run diff backgrounds render transparent,
  byte-identical to base; addressability holds in both directions — a v2
  entry painting a background via a palette reference and clearing one via
  `{"bg": "transparent"}` both resolve.
