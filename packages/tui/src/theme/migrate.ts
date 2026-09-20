import { RGBA } from "@opentui/core"
import { ansiToRgba, transparentColor } from "./color"
import { LEGACY_COLOR_KEYS, type Theme, type ThemeColor, type ThemeJson } from "./types"

/**
 * The reason a theme file was rejected at load (Interface, R47).
 *
 * Purpose: the exact discrimination vocabulary surfaced to the user when a
 * theme file is dropped.
 *
 * Contract: exactly one code per rejection — `PARSE_ERROR` (not valid JSON),
 * `NOT_A_THEME` (no `theme` object), `MIXED_FORMATS` (dotted and legacy color
 * keys together), `UNKNOWN_ELEMENT` (name outside the catalog),
 * `UNKNOWN_ATTRIBUTE` (name outside the eight), `INVALID_COLOR` (malformed
 * hex, ANSI index outside 0–255, or a non-color value),
 * `UNRESOLVED_REFERENCE`, `CYCLIC_REFERENCE`, `INVALID_ENTRY` (an
 * element-style member outside `fg`/`bg`/`attributes`, or a non-array
 * `attributes`).
 */
export type ThemeRejectionReason =
  | "PARSE_ERROR"
  | "NOT_A_THEME"
  | "MIXED_FORMATS"
  | "UNKNOWN_ELEMENT"
  | "UNKNOWN_ATTRIBUTE"
  | "INVALID_COLOR"
  | "UNRESOLVED_REFERENCE"
  | "CYCLIC_REFERENCE"
  | "INVALID_ENTRY"

/**
 * A load rejection in flight.
 *
 * Purpose: carries the reason code alongside the user-facing message while
 * validation unwinds, so `loadTheme` can map it onto a rejected result.
 *
 * Contract: thrown only inside the load pipeline; `loadTheme` turns it into a
 * rejected `ThemeLoadResult` and it never escapes to callers of the public
 * API.
 */
export class ThemeRejection extends Error {
  constructor(
    readonly reason: ThemeRejectionReason,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Migrates a v1 theme source into the resolved flat palette (R21–R24).
 *
 * Purpose: the load-time conversion every v1 source goes through — built-in
 * files, discovered user files, plugin-installed themes, and the generated
 * `system` theme — before element resolution.
 *
 * Contract: `source` must be a v1 `ThemeJson` (a `theme` object with no
 * dotted key). Reads the live legacy keys into the palette (including custom
 * names, so v1 keys can reference them), applies the fallbacks
 * `selectedListItemText` → `background` and `backgroundMenu` →
 * `backgroundElement` (R22), ignores the dropped legacy keys without error,
 * and carries `thinkingOpacity` through unchanged (default 0.6). Color
 * values resolve exactly one shared grammar: hex, ANSI 0–255, `none` /
 * `transparent`, `{dark, light}` variants by `mode`, references into `defs`
 * then the file's own keys then `fallback`. A palette name missing from the
 * file falls back to `fallback` — the resolved palette of the default
 * built-in theme (R24). Returns a complete flat `Theme`; rejects with
 * `ThemeRejection` (`INVALID_COLOR`, `UNRESOLVED_REFERENCE`,
 * `CYCLIC_REFERENCE`) on invalid values or reference graphs. Never rewrites
 * the file on disk.
 */
export function migrateThemeV1(source: ThemeJson, mode: "dark" | "light", fallback?: Theme): Theme {
  const defs = source.defs ?? {}
  const entries = source.theme
  // Hyphenated names resolve: built-in themes ship defs names like "purple-400"
  // and migration must stay lossless for rendered output (R23, A21).
  const refPattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/
  const hexPattern = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

  function resolveColor(value: unknown, chain: string[]): RGBA {
    if (value instanceof RGBA) return value
    if (typeof value === "string") {
      if (value === "transparent" || value === "none") return transparentColor()
      if (value.startsWith("#")) {
        if (!hexPattern.test(value)) {
          throw new ThemeRejection("INVALID_COLOR", `Invalid hex color: "${value}"`)
        }
        return RGBA.fromHex(value)
      }
      if (refPattern.test(value)) {
        if (chain.includes(value)) {
          throw new ThemeRejection("CYCLIC_REFERENCE", `Circular color reference: ${[...chain, value].join(" -> ")}`)
        }
        const next = defs[value] ?? (entries as Record<string, unknown>)[value] ?? fallback?.[value as ThemeColor]
        if (next === undefined) {
          throw new ThemeRejection("UNRESOLVED_REFERENCE", `Color reference "${value}" not found in defs or theme`)
        }
        return resolveColor(next, [...chain, value])
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
      return resolveColor(mode === "dark" ? variant.dark : variant.light, chain)
    }
    throw new ThemeRejection("INVALID_COLOR", `Invalid color value: ${JSON.stringify(value) ?? "?"}`)
  }

  const flat: Record<string, RGBA> = {}
  for (const [key, value] of Object.entries(entries)) {
    if (key === "thinkingOpacity") continue
    flat[key] = resolveColor(value, [])
  }

  const hasSelectedListItemText = entries.selectedListItemText !== undefined
  if (!hasSelectedListItemText) {
    flat.selectedListItemText = flat.background ?? fallback?.background ?? transparentColor()
  }
  if (flat.backgroundMenu === undefined) {
    flat.backgroundMenu = flat.backgroundElement ?? fallback?.backgroundElement ?? transparentColor()
  }
  if (fallback) {
    for (const key of LEGACY_COLOR_KEYS) {
      if (flat[key] === undefined) flat[key] = fallback[key]
    }
  }

  const thinkingOpacity = typeof entries.thinkingOpacity === "number" ? entries.thinkingOpacity : 0.6
  return { ...flat, _hasSelectedListItemText: hasSelectedListItemText, thinkingOpacity } as Theme
}
