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

## D-6 2026-09-21 specs/tui-theme.md
Spec edit: catalog errata — byte-identical defaults made binding (R48),
  catalog defaults corrected to the actual rendering, missing elements added,
  dangling elements dropped, syntax/markdown scope rules re-assigned to
  split elements, run block diff fields become `run.block.diff.*` elements
  (R44 rewritten), queued-chip computed override fixed (R49); supersedes
  entry `D-3`, whose `Now` cited palette diff names for the run diff fields
  that R44 no longer prescribes.
Was: the migrated components keep flat-read workarounds at the corrected
  surfaces (permission border and option fg, question hover tones, message
  error body, unfocused select row, diff filetree selection, session
  scrollbar track, prompt cursor) and hold spec-gap comments at the surfaces
  the new elements govern; the scope table sources `string.escape`,
  `string.regexp`, `keyword.import`, `keyword.export`, `tag.attribute`,
  `comment.error`, `comment.warning`, `comment.todo`, `comment.note`,
  `error`, `warning`, `markup.link.label`, `markup.underline`, `label`,
  `markup.raw`, `markup.raw.block`, `keyword.type`, `type`, `module`,
  `class`, and `namespace` from elements whose defaults differ from the
  pre-v2 flags (pinned as CATALOG_DELTAS in
  packages/tui/test/theme-syntax.test.ts); packages/opencode/src/cli/cmd/run/theme.ts
  maps the block diff RunTheme fields from the palette diff names of the
  effective theme.
Now: catalog defaults equal the pre-v2 rendering byte for byte (R48), every
  listed surface has a governing element, and the run diff fields resolve
  from `run.block.diff.*` elements a theme may clear (for example
  `{"bg": "transparent"}`).
Code impact: packages/tui/src/theme/catalog.ts (corrected defaults, new
  rows, dropped `markdown.code` and `prompt.cursor.unfocused`),
  packages/tui/src/theme/index.ts (scope-to-element table),
  routes/session/{permission,question,index}.tsx, ui/{dialog-select,dialog-prompt,toast}.tsx,
  component/{dialog-provider,dialog-status,dialog-workspace-file-changes,
  dialog-workspace-list,plugin-route-missing,prompt/index,prompt/autocomplete}.tsx,
  feature-plugins/{system/which-key,sidebar/footer}.tsx,
  routes/session/subagent-footer.tsx (wire the new elements, drop the flat
  reads), packages/opencode/src/cli/cmd/run/theme.ts (element mapping for
  the diff fields), packages/web/public/theme.json and themes.mdx locale
  copies (entry `D-5` scope, catalog reference).
Tests: the CATALOG_DELTAS pins in packages/tui/test/theme-syntax.test.ts
  must collapse to zero deltas (every LEGACY_RULES entry green); resolution
  tests for the added and dropped elements; run diff fields resolve to the
  same values the palette diff names produced.
Review focus: default-theme rendering identical to the pre-v2 build; no
  consumer reads a dropped element; the question hover number tint and the
  toast variant borders match the flat reads they replace.
