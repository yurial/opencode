import { RGBA } from "@opentui/core"
import {
  ATTRIBUTES,
  CATALOG,
  isElementName,
  type Attribute,
  type ColorDefault,
  type ColorValue,
  type ElementDefault,
  type ElementName,
  type ElementStyle,
  type ResolvedElement,
} from "./catalog"
import { HEX_PATTERN, REF_PATTERN, ansiToRgba, tint, transparentColor } from "./color"
import { migrateThemeV1, ThemeRejection, type ThemeRejectionReason } from "./migrate"
import { DEFAULT_THEMES } from "./builtin"
import { LEGACY_COLOR_KEYS, type Theme, type ThemeColor, type ThemeJson } from "./types"

/**
 * A theme source prepared for element resolution.
 *
 * Purpose: the internal v2 form every accepted or migrated theme file is
 * normalized into (R21) — the resolved palette plus the v2 overrides.
 *
 * Contract: `theme` is the resolved flat palette (legacy key names → RGBA,
 * fallbacks applied, `thinkingOpacity` carried) and doubles as the legacy
 * projection consumed by existing components; `entries` holds the file's v2
 * element entries (empty for migrated v1 sources, whose elements come entirely
 * from catalog defaults); `defs` holds the file's named color constants
 * (empty for migrated v1 sources, whose defs are consumed by migration);
 * `mode` is the mode the palette was resolved with and selects `{dark, light}`
 * arms at element resolution time. Instances are immutable snapshots per
 * (file, mode); the resolver caches per-instance, so never mutate anything
 * reachable from a `PreparedTheme` after creation.
 */
export type PreparedTheme = {
  readonly mode: "dark" | "light"
  readonly theme: Theme
  readonly entries: Readonly<Record<string, ElementStyle>>
  readonly defs: Readonly<Record<string, ColorValue>>
}

/**
 * The result of loading a theme file (Interface, R47).
 *
 * Purpose: accepted-v2 / migrated-v1 / rejected-with-reason discrimination.
 *
 * Contract: `ok: true` carries the `PreparedTheme` and the source format —
 * `"v2"` for a native v2 file, `"v1"` for a file that went through migration.
 * `ok: false` carries exactly one `ThemeRejectionReason` and a user-facing
 * message; a rejected file must be excluded from the theme registry with the
 * active theme falling back to the default built-in theme (R47).
 */
export type ThemeLoadResult =
  | { readonly ok: true; readonly format: "v1" | "v2"; readonly theme: PreparedTheme }
  | { readonly ok: false; readonly reason: ThemeRejectionReason; readonly message: string }

/**
 * Loads a theme file into the internal v2 form (R18–R24, R47).
 *
 * Purpose: the single entry point of the load pipeline — parse, discriminate,
 * validate, migrate or accept, and prepare for element resolution.
 *
 * Contract: `input` is either a raw string (parsed as JSON; invalid JSON →
 * `PARSE_ERROR`) or an already-parsed value; `mode` selects the `{dark,
 * light}` arm and the palette of the default built-in theme. A file whose
 * `theme` object contains at least one dotted key is treated as v2, a file
 * with no dotted key as v1 (R18). v1 files migrate losslessly (R21–R23); v2
 * files resolve against the resolved palette of the default built-in theme
 * (R24) with the file's `defs` taking precedence. Returns a rejected result
 * with exactly one reason code on any violation; never throws. The input is
 * never mutated.
 */
export function loadTheme(input: string | unknown, mode: "dark" | "light"): ThemeLoadResult {
  let source = input
  if (typeof input === "string") {
    try {
      source = JSON.parse(input)
    } catch (error) {
      return { ok: false, reason: "PARSE_ERROR", message: `Theme file is not valid JSON: ${(error as Error).message}` }
    }
  }
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return { ok: false, reason: "NOT_A_THEME", message: "Theme file must be a JSON object" }
  }
  const theme = (source as { theme?: unknown }).theme
  if (typeof theme !== "object" || theme === null || Array.isArray(theme)) {
    return { ok: false, reason: "NOT_A_THEME", message: "Theme file has no theme object" }
  }

  const keys = Object.keys(theme)
  if (!keys.some((key) => key.includes("."))) {
    try {
      const migrated = migrateThemeV1(source as ThemeJson, mode, defaultTheme(mode))
      return { ok: true, format: "v1", theme: { mode, theme: migrated, entries: {}, defs: {} } }
    } catch (error) {
      if (error instanceof ThemeRejection) return { ok: false, reason: error.reason, message: error.message }
      throw error
    }
  }

  if (keys.some((key) => LEGACY_COLOR_KEYS.includes(key as ThemeColor))) {
    return { ok: false, reason: "MIXED_FORMATS", message: "Theme mixes v2 element keys with legacy v1 color keys" }
  }

  try {
    const defs: Record<string, ColorValue> = {}
    const defsSource = (source as { defs?: unknown }).defs
    if (defsSource !== undefined) {
      if (typeof defsSource !== "object" || defsSource === null || Array.isArray(defsSource)) {
        return { ok: false, reason: "NOT_A_THEME", message: "Theme defs must be an object" }
      }
      for (const [name, value] of Object.entries(defsSource as Record<string, unknown>)) {
        validateColorValue(value)
        defs[name] = value as ColorValue
      }
    }

    const entries: Record<string, ElementStyle> = {}
    for (const [name, value] of Object.entries(theme as Record<string, unknown>)) {
      if (name === "thinkingOpacity") continue
      if (!isElementName(name)) {
        return { ok: false, reason: "UNKNOWN_ELEMENT", message: `Unknown theme element: "${name}"` }
      }
      entries[name] = validateEntry(value, name)
    }

    const flat = { ...defaultTheme(mode) }
    const opacity = (theme as Record<string, unknown>).thinkingOpacity
    if (typeof opacity === "number") flat.thinkingOpacity = opacity
    const prepared: PreparedTheme = { mode, theme: flat, entries, defs }
    // Resolve every element so reference and cycle violations surface at load.
    for (const name of Object.keys(CATALOG)) resolveElement(prepared, name)
    return { ok: true, format: "v2", theme: prepared }
  } catch (error) {
    if (error instanceof ThemeRejection) return { ok: false, reason: error.reason, message: error.message }
    throw error
  }
}

function validateEntry(value: unknown, name: string): ElementStyle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ThemeRejection("INVALID_ENTRY", `Element "${name}" entry must be an object`)
  }
  const entry = value as Record<string, unknown>
  for (const member of Object.keys(entry)) {
    if (member !== "fg" && member !== "bg" && member !== "attributes") {
      throw new ThemeRejection("INVALID_ENTRY", `Element "${name}" has unknown member "${member}"`)
    }
  }
  if (entry.attributes !== undefined) {
    if (!Array.isArray(entry.attributes)) {
      throw new ThemeRejection("INVALID_ENTRY", `Element "${name}" attributes must be an array`)
    }
    for (const attribute of entry.attributes) {
      if (!ATTRIBUTES.includes(attribute as Attribute)) {
        throw new ThemeRejection("UNKNOWN_ATTRIBUTE", `Unknown text attribute: "${String(attribute)}"`)
      }
    }
  }
  if (entry.fg !== undefined) validateColorValue(entry.fg)
  if (entry.bg !== undefined) validateColorValue(entry.bg)
  return entry as ElementStyle
}

function validateColorValue(value: unknown): void {
  if (value instanceof RGBA) return
  if (typeof value === "string") {
    if (value === "transparent" || value === "none") return
    if (value.startsWith("#")) {
      if (!HEX_PATTERN.test(value)) throw new ThemeRejection("INVALID_COLOR", `Invalid hex color: "${value}"`)
      return
    }
    // Dotted names are element references; the resolver checks the catalog.
    if (value.includes(".")) return
    if (REF_PATTERN.test(value)) return
    throw new ThemeRejection("INVALID_COLOR", `Invalid color value: "${value}"`)
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new ThemeRejection("INVALID_COLOR", `ANSI color index out of bounds: ${value}`)
    }
    return
  }
  if (typeof value === "object" && value !== null) {
    const variant = value as { dark?: unknown; light?: unknown }
    if (variant.dark === undefined || variant.light === undefined) {
      throw new ThemeRejection("INVALID_COLOR", `Variant color requires both "dark" and "light" arms`)
    }
    validateColorValue(variant.dark)
    validateColorValue(variant.light)
    return
  }
  throw new ThemeRejection("INVALID_COLOR", `Invalid color value: ${JSON.stringify(value) ?? "?"}`)
}

const defaults = new Map<"dark" | "light", Theme>()

/**
 * The resolved palette of the default built-in theme, cached per mode (R24).
 *
 * Purpose: the palette a native v2 file resolves against, and the fallback
 * source for palette names missing from a v1 file.
 *
 * Contract: `mode` selects the `{dark, light}` arms; the result is the flat
 * resolved palette of `DEFAULT_THEMES.opencode`, shared between loads — treat
 * it as immutable.
 */
function defaultTheme(mode: "dark" | "light"): Theme {
  const cached = defaults.get(mode)
  if (cached) return cached
  const theme = migrateThemeV1(DEFAULT_THEMES.opencode, mode)
  defaults.set(mode, theme)
  return theme
}

const cache = new WeakMap<PreparedTheme, Map<string, ResolvedElement>>()

/**
 * Resolves one catalog element to its concrete channels (R25–R34, R42, R43).
 *
 * Purpose: the resolution core behind the reactive `element(name)` accessor.
 *
 * Contract: `prepared` comes from `loadTheme`; `name` must be a catalog
 * element name — anything else throws (`element(name)` with a non-catalog
 * name is a programming error, never a load rejection). Entry channels win
 * over catalog defaults (R25); partial entries keep catalog defaults and a
 * present `attributes` array replaces the default set wholesale (R26);
 * dotless references resolve `defs` → palette and dotted references resolve
 * to the referenced element channel-wise with attributes never flowing
 * through (R27, R28); ANSI indices resolve through the fixed vga-table (R30);
 * `{dark, light}` variants follow `prepared.mode` (R31); the computed
 * `selected-foreground` default evaluates against the element's own resolved
 * background (R32, R33); the computed `dimmed-palette` default multiplies the
 * resolved palette color's alpha by its fixed scalar (R34). Results are cached
 * per `prepared` instance; the returned `attributes` set must not be mutated.
 */
export function resolveElement(prepared: PreparedTheme, name: string): ResolvedElement {
  if (!isElementName(name)) throw new Error(`Unknown theme element: "${name}"`)
  let memo = cache.get(prepared)
  if (!memo) {
    memo = new Map()
    cache.set(prepared, memo)
  }
  const cached = memo.get(name)
  if (cached) return cached
  const resolved = resolveNamed(prepared, name, [name])
  memo.set(name, resolved)
  return resolved
}

function resolveNamed(prepared: PreparedTheme, name: string, chain: string[]): ResolvedElement {
  const def: ElementDefault = CATALOG[name as ElementName]
  const entry = prepared.entries[name]
  let fgValue: RGBA | undefined
  let bgValue: RGBA | undefined
  const fg = () => {
    if (fgValue) return fgValue
    fgValue = entry?.fg !== undefined
      ? isColorDefault(entry.fg)
        ? defaultColor(prepared, entry.fg as unknown as ColorDefault, name, chain, bg)
        : resolveColorValue(prepared, entry.fg, "fg", prepared.mode, name, chain)
      : defaultColor(prepared, def.fg, name, chain, bg)
    return fgValue
  }
  const bg = () => {
    if (bgValue) return bgValue
    bgValue = entry?.bg !== undefined
      ? isColorDefault(entry.bg)
        ? defaultColor(prepared, entry.bg as unknown as ColorDefault, name, chain, fg)
        : resolveColorValue(prepared, entry.bg, "bg", prepared.mode, name, chain)
      : defaultColor(prepared, def.bg, name, chain, fg)
    return bgValue
  }
  return { fg: fg(), bg: bg(), attributes: new Set(entry?.attributes ?? def.attributes ?? []) }
}

// Distinguishes a computed catalog `ColorDefault` from a file-grammar
// `ColorValue`: entries normally carry file values, but the prepared form may
// carry computed defaults (e.g. tests assembling `PreparedTheme` directly),
// and both flow through the same entry branch.
function isColorDefault(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    typeof (value as { source: unknown }).source === "string"
  )
}

function paletteOf(prepared: PreparedTheme): Record<string, RGBA> {
  return prepared.theme as unknown as Record<string, RGBA>
}

function defaultColor(
  prepared: PreparedTheme,
  def: ColorDefault | undefined,
  name: string,
  chain: string[],
  other: () => RGBA,
): RGBA {
  if (!def || def.source === "transparent") return transparentColor()
  if (def.source === "palette") {
    const value = paletteOf(prepared)[def.name]
    if (value === undefined) {
      throw new ThemeRejection("UNRESOLVED_REFERENCE", `Palette color "${def.name}" not found for element "${name}"`)
    }
    return value
  }
  if (def.source === "hex") return RGBA.fromHex(def.value)
  if (def.source === "selected-foreground") return selectedForeground(prepared.theme, other())
  if (def.source === "element-foreground") return other()
  if (def.source === "dimmed-palette") {
    // tui-theme/dimmed-palette (R34): the resolved palette color with its
    // alpha channel multiplied by the fixed scalar; alpha 1 equals the plain
    // palette color (the subtle-syntax alpha multiply, R37).
    const value = paletteOf(prepared)[def.name]
    if (value === undefined) {
      throw new ThemeRejection("UNRESOLVED_REFERENCE", `Palette color "${def.name}" not found for element "${name}"`)
    }
    return RGBA.fromValues(value.r, value.g, value.b, value.a * def.alpha)
  }
  return tint(
    defaultColor(prepared, def.base, name, chain, other),
    defaultColor(prepared, def.overlay, name, chain, other),
    def.alpha,
  )
}

function resolveColorValue(
  prepared: PreparedTheme,
  value: ColorValue | RGBA,
  channel: "fg" | "bg",
  mode: "dark" | "light",
  owner: string,
  chain: string[],
): RGBA {
  if (value instanceof RGBA) return value
  if (typeof value === "string") {
    if (value === "transparent" || value === "none") return transparentColor()
    if (value.startsWith("#")) {
      if (!HEX_PATTERN.test(value)) {
        throw new ThemeRejection("INVALID_COLOR", `Invalid hex color: "${value}"`)
      }
      return RGBA.fromHex(value)
    }
    if (value.includes(".")) {
      if (!isElementName(value)) {
        throw new ThemeRejection("UNRESOLVED_REFERENCE", `Element "${owner}" references unknown element "${value}"`)
      }
      if (chain.includes(value)) {
        throw new ThemeRejection("CYCLIC_REFERENCE", `Circular color reference: ${[...chain, value].join(" -> ")}`)
      }
      const ref = resolveNamed(prepared, value, [...chain, value])
      return channel === "fg" ? ref.fg : ref.bg
    }
    if (REF_PATTERN.test(value)) {
      if (chain.includes(value)) {
        throw new ThemeRejection("CYCLIC_REFERENCE", `Circular color reference: ${[...chain, value].join(" -> ")}`)
      }
      const def = prepared.defs[value]
      if (def !== undefined) return resolveColorValue(prepared, def, channel, mode, owner, [...chain, value])
      const palette = paletteOf(prepared)[value]
      if (palette !== undefined) return palette
      throw new ThemeRejection("UNRESOLVED_REFERENCE", `Color reference "${value}" not found in defs or theme`)
    }
    throw new ThemeRejection("INVALID_COLOR", `Invalid color value: "${value}"`)
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new ThemeRejection("INVALID_COLOR", `ANSI color index out of bounds: ${value}`)
    }
    return ansiToRgba(value)
  }
  if (typeof value === "object" && value !== null) {
    const variant = value as { dark?: unknown; light?: unknown }
    if (variant.dark === undefined || variant.light === undefined) {
      throw new ThemeRejection("INVALID_COLOR", `Variant color requires both "dark" and "light" arms`)
    }
    const arm = mode === "dark" ? variant.dark : variant.light
    return resolveColorValue(prepared, arm as ColorValue, channel, mode, owner, chain)
  }
  throw new ThemeRejection("INVALID_COLOR", `Invalid color value: ${JSON.stringify(value) ?? "?"}`)
}

/**
 * Contrast rule for foregrounds painted over a selection (R33).
 *
 * Purpose: the computed tui-theme/selected-foreground derivation and the
 * legacy helper of the same name.
 *
 * Contract: returns the palette `selectedListItemText` when explicitly set;
 * otherwise, when the palette `background` is transparent, black or white by
 * the luminance of `bg` (falling back to the palette `primary` when no `bg`
 * is given — legacy behavior for callers that have no element background);
 * otherwise the palette `background`.
 */
export function selectedForeground(theme: Theme, bg?: RGBA): RGBA {
  if (theme._hasSelectedListItemText) {
    return theme.selectedListItemText
  }

  if (theme.background.a === 0) {
    const targetColor = bg ?? theme.primary
    const { r, g, b } = targetColor
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b
    return luminance > 0.5 ? RGBA.fromInts(0, 0, 0) : RGBA.fromInts(255, 255, 255)
  }

  return theme.background
}
