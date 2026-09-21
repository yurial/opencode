import { RGBA } from "@opentui/core"

/**
 * The fixed tui-theme/vga-table lookup (R30).
 *
 * Purpose: resolves an integer ANSI color index to an RGBA value without ever
 * reading the live terminal palette.
 *
 * Contract: `code` must be an integer within 0–255 (callers validate bounds
 * and reject outside values with `INVALID_COLOR`). 0–15 map to the fixed VGA
 * base colors, 16–231 to the 6×6×6 cube, 232–255 to the grayscale ramp. The
 * fallback black branch is unreachable for validated input and exists only to
 * satisfy the type checker.
 */
export function ansiToRgba(code: number): RGBA {
  // Standard ANSI colors (0-15)
  if (code < 16) {
    const ansiColors = [
      "#000000", // Black
      "#800000", // Red
      "#008000", // Green
      "#808000", // Yellow
      "#000080", // Blue
      "#800080", // Magenta
      "#008080", // Cyan
      "#c0c0c0", // White
      "#808080", // Bright Black
      "#ff0000", // Bright Red
      "#00ff00", // Bright Green
      "#ffff00", // Bright Yellow
      "#0000ff", // Bright Blue
      "#ff00ff", // Bright Magenta
      "#00ffff", // Bright Cyan
      "#ffffff", // Bright White
    ]
    return RGBA.fromHex(ansiColors[code] ?? "#000000")
  }

  // 6x6x6 Color Cube (16-231)
  if (code < 232) {
    const index = code - 16
    const b = index % 6
    const g = Math.floor(index / 6) % 6
    const r = Math.floor(index / 36)

    const val = (x: number) => (x === 0 ? 0 : x * 40 + 55)
    return RGBA.fromInts(val(r), val(g), val(b))
  }

  // Grayscale Ramp (232-255)
  if (code < 256) {
    const gray = (code - 232) * 10 + 8
    return RGBA.fromInts(gray, gray, gray)
  }

  // Fallback for invalid codes
  return RGBA.fromInts(0, 0, 0)
}

/**
 * A fresh fully transparent RGBA.
 *
 * Purpose: the value a channel with no default resolves to, and the result of
 * the `none`/`transparent` color values (R15).
 *
 * Contract: returns a new instance per call; never share or cache the result
 * because `RGBA` instances are mutable.
 */
export function transparentColor(): RGBA {
  return RGBA.fromInts(0, 0, 0, 0)
}

/**
 * The hex color grammar of the `fg`/`bg` channels and `defs` members (R15).
 *
 * Purpose: the shared validation regex for every place a color value is
 * parsed or validated — v1 migration and v2 resolution accept exactly the
 * same hex forms.
 *
 * Contract: matches `#` followed by 3, 4, 6, or 8 hex digits; nothing else.
 */
export const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/**
 * The reference-name grammar of the `fg`/`bg` channels and `defs` members.
 *
 * Purpose: the shared validation regex for dotless reference names — v1
 * migration and v2 resolution accept exactly the same names.
 *
 * Contract: a letter followed by letters, digits, underscores, or hyphens.
 * Hyphens are accepted in continuation positions: built-in themes ship
 * hyphenated defs names (e.g. mercury "purple-400") and migration must stay
 * lossless for rendered output (R23, A21).
 */
export const REF_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/

/**
 * Alpha blend of an overlay color over a base color (tui-theme/tint, R34).
 *
 * Purpose: the computed blend behind `logo.shadow`, `bg-pulse.base`, and the
 * run-zone derivatives.
 *
 * Contract: `alpha` is the overlay share in 0–1; the result is fully opaque —
 * both inputs' alpha channels are ignored and the result carries a = 255.
 * `base` and `overlay` are not mutated.
 */
export function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
  const r = base.r + (overlay.r - base.r) * alpha
  const g = base.g + (overlay.g - base.g) * alpha
  const b = base.b + (overlay.b - base.b) * alpha
  return RGBA.fromInts(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255))
}
