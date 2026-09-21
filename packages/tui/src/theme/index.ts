import { SyntaxStyle, RGBA, type TerminalColors } from "@opentui/core"
import { ansiToRgba, tint } from "./color"
import { loadTheme, resolveElement, selectedForeground, type PreparedTheme, type ThemeLoadResult } from "./resolve"
import { DEFAULT_THEMES } from "./builtin"
import { type ThemeRejectionReason } from "./migrate"
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
  type ThemeFileV2,
} from "./catalog"
import type { Theme, ThemeColor, ThemeJson } from "./types"

export type {
  Theme,
  ThemeColor,
  ThemeJson,
} from "./types"
export { tint }
export { DEFAULT_THEMES }
export {
  CATALOG,
  isElementName,
  ATTRIBUTES,
  type Attribute,
  type ColorDefault,
  type ColorValue,
  type ElementDefault,
  type ElementName,
  type ElementStyle,
  type ResolvedElement,
  type ThemeFileV2,
}
export { loadTheme, selectedForeground, type PreparedTheme, type ThemeLoadResult }
export { resolveElement } from "./resolve"
export { type ThemeRejectionReason }

const pluginThemes: Record<string, ThemeJson> = {}
let customThemes: Record<string, ThemeJson> = {}
let systemTheme: ThemeJson | undefined
const listeners = new Set<(themes: Record<string, ThemeJson>) => void>()

function listThemes() {
  // Priority: defaults < plugin installs < custom files < generated system.
  const themes = {
    ...DEFAULT_THEMES,
    ...pluginThemes,
    ...customThemes,
  }
  if (!systemTheme) return themes
  return {
    ...themes,
    system: systemTheme,
  }
}

function syncThemes() {
  const themes = listThemes()
  for (const listener of listeners) listener(themes)
}

export function allThemes() {
  return listThemes()
}

export function isTheme(theme: unknown): theme is ThemeJson {
  if (typeof theme !== "object" || theme === null || Array.isArray(theme)) return false
  const value = Reflect.get(theme, "theme")
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function subscribeThemes(listener: (themes: Record<string, ThemeJson>) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setCustomThemes(themes: Record<string, ThemeJson>) {
  customThemes = themes
  syncThemes()
}

export function setSystemTheme(theme: ThemeJson | undefined) {
  systemTheme = theme
  syncThemes()
}

export function hasTheme(name: string) {
  if (!name) return false
  return allThemes()[name] !== undefined
}

export function addTheme(name: string, theme: unknown) {
  if (!name) return false
  if (!isTheme(theme)) return false
  if (hasTheme(name)) return false
  pluginThemes[name] = theme
  syncThemes()
  return true
}

export function upsertTheme(name: string, theme: unknown) {
  if (!name) return false
  if (!isTheme(theme)) return false
  if (customThemes[name] !== undefined) {
    customThemes[name] = theme
  } else {
    pluginThemes[name] = theme
  }
  syncThemes()
  return true
}

/**
 * Resolves a theme source into the legacy flat palette view.
 *
 * Purpose: the compatibility projection every v1 consumer keeps using while
 * components migrate to `element(name)`.
 *
 * Contract: `theme` is a `ThemeJson` in either format — v1 sources migrate at
 * load (R21), v2 sources resolve against the default built-in palette (R24).
 * Returns the flat `Theme` (legacy key names → RGBA) whose values are exactly
 * the palette the element resolver uses, so flat reads and element reads never
 * disagree. Throws on invalid sources (circular references, invalid colors)
 * with the rejection message — legacy call sites rely on the throw to fall
 * back to the default theme.
 */
export function resolveTheme(theme: ThemeJson, mode: "dark" | "light"): Theme {
  const result = loadTheme(theme, mode)
  if (!result.ok) throw new Error(result.message)
  return result.theme.theme
}

export function terminalMode(colors: TerminalColors): "dark" | "light" | undefined {
  const bg = colors.defaultBackground
  if (!bg) return
  const { r, g, b } = RGBA.fromHex(bg)
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.5 ? "light" : "dark"
}

export function generateSystem(colors: TerminalColors, mode: "dark" | "light"): ThemeJson {
  const bg = RGBA.fromHex(colors.defaultBackground ?? colors.palette[0]!)
  const fg = RGBA.fromHex(colors.defaultForeground ?? colors.palette[7]!)
  const transparent = RGBA.fromValues(bg.r, bg.g, bg.b, 0)
  const isDark = mode == "dark"

  const col = (i: number) => {
    const value = colors.palette[i]
    if (value) return RGBA.fromHex(value)
    return ansiToRgba(i)
  }

  // Generate gray scale based on terminal background
  const grays = generateGrayScale(bg, isDark)
  const textMuted = generateMutedTextColor(bg, isDark)

  // ANSI color references
  const ansiColors = {
    black: col(0),
    red: col(1),
    green: col(2),
    yellow: col(3),
    blue: col(4),
    magenta: col(5),
    cyan: col(6),
    white: col(7),
    redBright: col(9),
    greenBright: col(10),
  }

  const diffAlpha = isDark ? 0.22 : 0.14
  const diffAddedBg = tint(bg, ansiColors.green, diffAlpha)
  const diffRemovedBg = tint(bg, ansiColors.red, diffAlpha)
  const diffContextBg = grays[2]
  const diffAddedLineNumberBg = tint(diffContextBg, ansiColors.green, diffAlpha)
  const diffRemovedLineNumberBg = tint(diffContextBg, ansiColors.red, diffAlpha)
  const diffLineNumber = textMuted

  return {
    theme: {
      // Primary colors using ANSI
      primary: ansiColors.cyan,
      secondary: ansiColors.magenta,
      accent: ansiColors.cyan,

      // Status colors using ANSI
      error: ansiColors.red,
      warning: ansiColors.yellow,
      success: ansiColors.green,
      info: ansiColors.cyan,

      // Text colors
      text: fg,
      textMuted,
      selectedListItemText: bg,

      // Background colors - use transparent to respect terminal transparency
      background: transparent,
      backgroundPanel: grays[2],
      backgroundElement: grays[3],
      backgroundMenu: grays[3],

      // Border colors
      borderSubtle: grays[6],
      border: grays[7],
      borderActive: grays[8],

      // Diff colors
      diffAdded: ansiColors.green,
      diffRemoved: ansiColors.red,
      diffContext: grays[7],
      diffHunkHeader: grays[7],
      diffHighlightAdded: ansiColors.greenBright,
      diffHighlightRemoved: ansiColors.redBright,
      diffAddedBg,
      diffRemovedBg,
      diffContextBg,
      diffLineNumber,
      diffAddedLineNumberBg,
      diffRemovedLineNumberBg,

      // Markdown colors
      markdownText: fg,
      markdownHeading: fg,
      markdownLink: ansiColors.blue,
      markdownLinkText: ansiColors.cyan,
      markdownCode: ansiColors.green,
      markdownBlockQuote: ansiColors.yellow,
      markdownEmph: ansiColors.yellow,
      markdownStrong: fg,
      markdownHorizontalRule: grays[7],
      markdownListItem: ansiColors.blue,
      markdownListEnumeration: ansiColors.cyan,
      markdownImage: ansiColors.blue,
      markdownImageText: ansiColors.cyan,
      markdownCodeBlock: fg,

      // Syntax colors
      syntaxComment: textMuted,
      syntaxKeyword: ansiColors.magenta,
      syntaxFunction: ansiColors.blue,
      syntaxVariable: fg,
      syntaxString: ansiColors.green,
      syntaxNumber: ansiColors.yellow,
      syntaxType: ansiColors.cyan,
      syntaxOperator: ansiColors.cyan,
      syntaxPunctuation: fg,
    },
  }
}

function generateGrayScale(bg: RGBA, isDark: boolean): Record<number, RGBA> {
  const grays: Record<number, RGBA> = {}

  // RGBA stores floats in range 0-1, convert to 0-255
  const bgR = bg.r * 255
  const bgG = bg.g * 255
  const bgB = bg.b * 255

  const luminance = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB

  for (let i = 1; i <= 12; i++) {
    const factor = i / 12.0

    let grayValue: number
    let newR: number
    let newG: number
    let newB: number

    if (isDark) {
      if (luminance < 10) {
        grayValue = Math.floor(factor * 0.4 * 255)
        newR = grayValue
        newG = grayValue
        newB = grayValue
      } else {
        const newLum = luminance + (255 - luminance) * factor * 0.4

        const ratio = newLum / luminance
        newR = Math.min(bgR * ratio, 255)
        newG = Math.min(bgG * ratio, 255)
        newB = Math.min(bgB * ratio, 255)
      }
    } else {
      if (luminance > 245) {
        grayValue = Math.floor(255 - factor * 0.4 * 255)
        newR = grayValue
        newG = grayValue
        newB = grayValue
      } else {
        const newLum = luminance * (1 - factor * 0.4)

        const ratio = newLum / luminance
        newR = Math.max(bgR * ratio, 0)
        newG = Math.max(bgG * ratio, 0)
        newB = Math.max(bgB * ratio, 0)
      }
    }

    grays[i] = RGBA.fromInts(Math.floor(newR), Math.floor(newG), Math.floor(newB))
  }

  return grays
}

function generateMutedTextColor(bg: RGBA, isDark: boolean): RGBA {
  // RGBA stores floats in range 0-1, convert to 0-255
  const bgR = bg.r * 255
  const bgG = bg.g * 255
  const bgB = bg.b * 255

  const bgLum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB

  let grayValue: number

  if (isDark) {
    if (bgLum < 10) {
      // Very dark/black background
      grayValue = 180 // #b4b4b4
    } else {
      // Scale up for lighter dark backgrounds
      grayValue = Math.min(Math.floor(160 + bgLum * 0.3), 200)
    }
  } else {
    if (bgLum > 245) {
      // Very light/white background
      grayValue = 75 // #4b4b4b
    } else {
      // Scale down for darker light backgrounds
      grayValue = Math.max(Math.floor(100 - (255 - bgLum) * 0.2), 60)
    }
  }

  return RGBA.fromInts(grayValue, grayValue, grayValue)
}

export type SyntaxStyleOverrides = Record<string, { italic?: boolean }>

/**
 * Adapts a theme source into the element-resolvable form (R40).
 *
 * Purpose: lets flat-based callers — the run CLI passes a `PreparedTheme`'s
 * legacy palette — keep generating element-sourced syntax rules without
 * re-loading the theme file.
 *
 * Contract: returns `source` unchanged when it already is a `PreparedTheme`;
 * a flat `Theme` is wrapped with no entries and no defs, so every rule style
 * resolves from catalog defaults against the palette alone. `mode` is never
 * read on that path — catalog defaults carry no `{dark, light}` arms (R31
 * applies to file entries only).
 */
function asPrepared(source: PreparedTheme | Theme): PreparedTheme {
  if ("entries" in source) return source
  return { mode: "dark", theme: source, entries: {}, defs: {} }
}

/**
 * Resolves one catalog element into a SyntaxStyle rule style (R40).
 *
 * Purpose: the single mapping from `ResolvedElement` to the renderer's rule
 * style shape — every syntax, markdown, and extmark rule sources its channels
 * and attributes here.
 *
 * Contract: `name` must be a catalog element name (`resolveElement` throws
 * otherwise). Foreground and background are copied when resolved
 * non-transparent and omitted otherwise — the transparent color paints
 * nothing, and an omitted channel lets the surface inherit. Each attribute of
 * the resolved set maps onto its expressible flag (`bold`, `italic`,
 * `underline`, `dim`); the rule style shape cannot express `blink`,
 * `inverse`, `hidden`, or `strikethrough`, and no element a rule sources
 * carries one (guarded by test — a future catalog addition must surface here,
 * never drop silently).
 */
function elementStyle(prepared: PreparedTheme, name: string) {
  const element = resolveElement(prepared, name)
  const style: {
    foreground?: RGBA
    background?: RGBA
    bold?: boolean
    italic?: boolean
    underline?: boolean
    dim?: boolean
  } = {}
  if (element.fg.a > 0) style.foreground = element.fg
  if (element.bg.a > 0) style.background = element.bg
  for (const attribute of element.attributes) {
    if (attribute === "bold") style.bold = true
    else if (attribute === "italic") style.italic = true
    else if (attribute === "underline") style.underline = true
    else if (attribute === "dim") style.dim = true
  }
  return style
}

/**
 * Builds the full syntax style for code and markdown rendering (R40, R41).
 *
 * Purpose: the shared generator behind the TUI context and the run CLI —
 * every scope rule takes its foreground, background, and attributes from the
 * corresponding `syntax.*`, `markdown.*`, or `prompt.extmark.*` element.
 *
 * Contract: `source` is a `PreparedTheme` (element entries participate, R25)
 * or a flat legacy `Theme` (catalog defaults resolve against the palette via
 * `asPrepared`). The result is a fresh `SyntaxStyle` the caller owns —
 * destroy it when replaced.
 */
export function generateSyntax(source: PreparedTheme | Theme) {
  return SyntaxStyle.fromTheme(getSyntaxRules(asPrepared(source)))
}

/**
 * Builds the subtle syntax variant for reasoning bodies (R37).
 *
 * Purpose: the same rules as `generateSyntax` with every present foreground
 * alpha replaced by the theme's `thinkingOpacity`, so reasoning text renders
 * muted; attributes are unchanged (R37).
 *
 * Contract: `overrides` may force per-scope flags — merged across the rule's
 * scopes, and never able to override the foreground. The multiplier is the
 * effective theme's flat `thinkingOpacity` (carried on `PreparedTheme.theme`,
 * default 0.6).
 */
export function generateSubtleSyntax(source: PreparedTheme | Theme, overrides?: SyntaxStyleOverrides) {
  const prepared = asPrepared(source)
  return SyntaxStyle.fromTheme(
    getSyntaxRules(prepared).map((rule) => {
      const override = rule.scope.reduce((acc, scope) => ({ ...acc, ...overrides?.[scope] }), {})
      const foreground = rule.style.foreground
      if (!foreground) return rule
      return {
        ...rule,
        style: {
          ...rule.style,
          ...override,
          foreground: RGBA.fromInts(
            Math.round(foreground.r * 255),
            Math.round(foreground.g * 255),
            Math.round(foreground.b * 255),
            Math.round(prepared.theme.thinkingOpacity * 255),
          ),
        },
      }
    }),
  )
}

/**
 * The scope → element rule table (R40, R41).
 *
 * Purpose: binds every tree-sitter highlight scope — and the prompt editor's
 * extmark style ids — to the catalog element its style resolves from.
 *
 * Contract: scope names are external tree-sitter identifiers; the extmark
 * style ids stay `extmark.*` (the prompt editor resolves them via
 * `getStyleId`) while their styles come from the `prompt.extmark.*` elements;
 * the scope `default` resolves to `syntax.default` (R41). Rule order matters
 * for scope specificity and mirrors the legacy highlight list. Styles resolve
 * through `elementStyle`: with the default built-in theme the output is
 * byte-identical to the legacy highlight list in both modes (R48).
 */
function getSyntaxRules(prepared: PreparedTheme) {
  const from = (name: string) => elementStyle(prepared, name)
  return [
    {
      scope: ["default"],
      style: from("syntax.default"),
    },
    {
      scope: ["prompt"],
      style: from("syntax.prompt"),
    },
    {
      scope: ["extmark.file"],
      style: from("prompt.extmark.file"),
    },
    {
      scope: ["extmark.agent"],
      style: from("prompt.extmark.agent"),
    },
    {
      scope: ["extmark.paste"],
      style: from("prompt.extmark.paste"),
    },
    {
      scope: ["comment"],
      style: from("syntax.comment"),
    },
    {
      scope: ["comment.documentation"],
      style: from("syntax.comment"),
    },
    {
      scope: ["string", "symbol"],
      style: from("syntax.string"),
    },
    {
      scope: ["number", "boolean"],
      style: from("syntax.number"),
    },
    {
      scope: ["character.special"],
      style: from("syntax.string"),
    },
    {
      scope: ["keyword.return", "keyword.conditional", "keyword.repeat", "keyword.coroutine"],
      style: from("syntax.keyword"),
    },
    {
      scope: ["keyword.type"],
      style: from("syntax.type.keyword"),
    },
    {
      scope: ["keyword.function", "function.method"],
      style: from("syntax.function"),
    },
    {
      scope: ["keyword"],
      style: from("syntax.keyword"),
    },
    {
      scope: ["keyword.import"],
      style: from("syntax.keyword.import"),
    },
    {
      scope: ["operator", "keyword.operator", "punctuation.delimiter"],
      style: from("syntax.operator"),
    },
    {
      scope: ["keyword.conditional.ternary"],
      style: from("syntax.operator"),
    },
    {
      scope: ["variable", "variable.parameter", "function.method.call", "function.call"],
      style: from("syntax.variable"),
    },
    {
      scope: ["variable.member", "function", "constructor"],
      style: from("syntax.function"),
    },
    {
      scope: ["type", "module"],
      style: from("syntax.type"),
    },
    {
      scope: ["constant"],
      style: from("syntax.number"),
    },
    {
      scope: ["property"],
      style: from("syntax.variable"),
    },
    {
      scope: ["class"],
      style: from("syntax.type"),
    },
    {
      scope: ["parameter"],
      style: from("syntax.variable"),
    },
    {
      scope: ["punctuation", "punctuation.bracket"],
      style: from("syntax.punctuation"),
    },
    {
      scope: ["variable.builtin", "type.builtin", "function.builtin", "module.builtin", "constant.builtin"],
      style: from("syntax.error"),
    },
    {
      scope: ["variable.super"],
      style: from("syntax.error"),
    },
    {
      scope: ["string.escape", "string.regexp"],
      style: from("syntax.escape"),
    },
    {
      scope: ["keyword.directive"],
      style: from("syntax.keyword"),
    },
    {
      scope: ["punctuation.special"],
      style: from("syntax.operator"),
    },
    {
      scope: ["keyword.modifier"],
      style: from("syntax.keyword"),
    },
    {
      scope: ["keyword.exception"],
      style: from("syntax.keyword"),
    },
    // Markdown — markup.* scopes resolve markdown.* elements (R40).
    {
      scope: ["markup.heading"],
      style: from("markdown.heading"),
    },
    {
      scope: ["markup.heading.1"],
      style: from("markdown.heading.h1"),
    },
    {
      scope: ["markup.heading.2"],
      style: from("markdown.heading"),
    },
    {
      scope: ["markup.heading.3"],
      style: from("markdown.heading"),
    },
    {
      scope: ["markup.heading.4"],
      style: from("markdown.heading"),
    },
    {
      scope: ["markup.heading.5"],
      style: from("markdown.heading"),
    },
    {
      scope: ["markup.heading.6"],
      style: from("markdown.heading"),
    },
    {
      scope: ["markup.bold", "markup.strong"],
      style: from("markdown.strong"),
    },
    {
      scope: ["markup.italic"],
      style: from("markdown.emph"),
    },
    {
      scope: ["markup.list"],
      style: from("markdown.list"),
    },
    {
      scope: ["markup.quote"],
      style: from("markdown.quote"),
    },
    {
      scope: ["markup.raw", "markup.raw.block"],
      style: from("markdown.code.block"),
    },
    {
      scope: ["markup.raw.inline"],
      style: from("markdown.code.inline"),
    },
    {
      scope: ["markup.link"],
      style: from("markdown.link"),
    },
    {
      scope: ["markup.link.label"],
      style: from("markdown.link.label"),
    },
    {
      scope: ["markup.link.url"],
      style: from("markdown.link"),
    },
    {
      scope: ["label"],
      style: from("markdown.label"),
    },
    {
      scope: ["spell", "nospell"],
      style: from("syntax.default"),
    },
    {
      scope: ["conceal"],
      style: from("syntax.conceal"),
    },
    // Additional common highlight groups
    {
      scope: ["string.special", "string.special.url"],
      style: from("markdown.link"),
    },
    {
      scope: ["character"],
      style: from("syntax.string"),
    },
    {
      scope: ["float"],
      style: from("syntax.number"),
    },
    {
      scope: ["comment.error"],
      style: from("syntax.comment.error"),
    },
    {
      scope: ["comment.warning"],
      style: from("syntax.comment.warning"),
    },
    {
      scope: ["comment.todo", "comment.note"],
      style: from("syntax.comment.todo"),
    },
    {
      scope: ["namespace"],
      style: from("syntax.type"),
    },
    {
      scope: ["field"],
      style: from("syntax.variable"),
    },
    {
      scope: ["type.definition"],
      style: from("syntax.type.definition"),
    },
    {
      scope: ["keyword.export"],
      style: from("syntax.keyword.import"),
    },
    {
      scope: ["attribute", "annotation"],
      style: from("syntax.warning"),
    },
    {
      scope: ["tag"],
      style: from("syntax.error"),
    },
    {
      scope: ["tag.attribute"],
      style: from("syntax.tag.attribute"),
    },
    {
      scope: ["tag.delimiter"],
      style: from("syntax.operator"),
    },
    {
      scope: ["markup.strikethrough"],
      style: from("syntax.conceal"),
    },
    {
      scope: ["markup.underline"],
      style: from("markdown.underline"),
    },
    {
      scope: ["markup.list.checked"],
      style: from("syntax.checked"),
    },
    {
      scope: ["markup.list.unchecked"],
      style: from("syntax.conceal"),
    },
    {
      scope: ["diff.plus"],
      style: from("syntax.diff.plus"),
    },
    {
      scope: ["diff.minus"],
      style: from("syntax.diff.minus"),
    },
    {
      scope: ["diff.delta"],
      style: from("syntax.diff.delta"),
    },
    {
      scope: ["error"],
      style: from("syntax.error.strong"),
    },
    {
      scope: ["warning"],
      style: from("syntax.warning.strong"),
    },
    {
      scope: ["info"],
      style: from("syntax.todo"),
    },
    {
      scope: ["debug"],
      style: from("syntax.conceal"),
    },
  ]
}

