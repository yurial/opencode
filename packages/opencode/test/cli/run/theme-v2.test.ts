import { expect, test } from "bun:test"
import { RGBA, type CliRenderer, type TerminalColors } from "@opentui/core"
import { DEFAULT_THEMES, resolveElement } from "@opencode-ai/tui/context/theme"
import { RUN_THEME_FALLBACK, loadPrepared, resolveRunTheme, runTheme } from "@/cli/cmd/run/theme"

const palette = ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"] as const

const vgaIndexed = Array.from({ length: 256 }, (_, index) => RGBA.fromIndex(index))

// Minimal v2 theme: defs reference, ANSI index, hex overrides of run.* elements.
const v2Theme = {
  $schema: "https://opencode.ai/theme.json",
  defs: { ember: "#ff5500" },
  theme: {
    "run.background": { bg: "#202020" },
    "run.footer.pane": { bg: "#101010" },
    "run.footer.text": { fg: "ember" },
    "run.footer.selected": { bg: "#123456" },
    "run.entry.user": { fg: "ember" },
    "run.entry.tool.start": { fg: 46 },
    "run.block.highlight": { fg: "#0000ff" },
    "run.splash.left": { fg: "#ff00ff" },
  },
}

function terminalColors(input: Partial<TerminalColors> = {}): TerminalColors {
  return {
    palette: Array.from({ length: 256 }, (_, index) => input.palette?.[index] ?? palette[index % palette.length]!),
    defaultBackground: input.defaultBackground ?? "#1a1b26",
    defaultForeground: input.defaultForeground ?? "#c0caf5",
    cursorColor: input.cursorColor ?? "#ff9e64",
    mouseForeground: input.mouseForeground ?? null,
    mouseBackground: input.mouseBackground ?? null,
    tekForeground: input.tekForeground ?? null,
    tekBackground: input.tekBackground ?? null,
    highlightBackground: input.highlightBackground ?? "#33467c",
    highlightForeground: input.highlightForeground ?? "#c0caf5",
  }
}

function renderer(input: { themeMode?: "dark" | "light"; colors?: TerminalColors; fail?: boolean } = {}) {
  return {
    themeMode: input.themeMode,
    getPalette: async () => {
      if (input.fail) {
        throw new Error("boom")
      }

      return input.colors ?? terminalColors()
    },
  } as CliRenderer
}

function rgb(color: unknown): number[] {
  expect(color).toBeInstanceOf(RGBA)
  return (color as RGBA).toInts()
}

function rgbIndexed(color: unknown): number[] {
  const rgba = color as RGBA
  expect(rgba.intent).toBe("indexed")
  return rgba.toInts()
}

test("maps the built-in opencode v1 theme to the same RunTheme the deleted v1 resolver produced", async () => {
  const prepared = await loadPrepared(DEFAULT_THEMES.opencode, "dark")
  const theme = runTheme(prepared, prepared, vgaIndexed, resolveElement)

  // Golden values captured from the pre-refactor resolveTheme() + map() output.
  expect(rgb(theme.background)).toEqual([10, 10, 10, 255])
  expect(rgb(theme.footer.highlight)).toEqual([250, 178, 131, 255])
  expect(rgb(theme.footer.selected)).toEqual([30, 30, 30, 255])
  // selectedListItemText is unset in opencode, so run.footer.selected-text
  // resolves to the palette background, like the v1 fallback did.
  expect(rgb(theme.footer.selectedText)).toEqual([10, 10, 10, 255])
  expect(rgb(theme.footer.warning)).toEqual([245, 167, 66, 255])
  expect(rgb(theme.footer.success)).toEqual([127, 216, 143, 255])
  expect(rgb(theme.footer.error)).toEqual([224, 108, 117, 255])
  expect(rgb(theme.footer.muted)).toEqual([128, 128, 128, 255])
  expect(rgb(theme.footer.text)).toEqual([238, 238, 238, 255])
  expect(rgb(theme.footer.status)).toEqual([20, 20, 20, 255])
  expect(rgb(theme.footer.statusAccent)).toEqual([34, 34, 34, 255])
  expect(rgb(theme.footer.shade)).toEqual([21, 21, 21, 255])
  expect(rgb(theme.footer.surface)).toEqual([25, 25, 25, 255])
  expect(rgb(theme.footer.pane)).toEqual([30, 30, 30, 255])
  expect(rgb(theme.footer.border)).toEqual([72, 72, 72, 255])
  expect(rgb(theme.footer.line)).toEqual([28, 28, 28, 255])
  expect(rgb(theme.entry.system.body)).toEqual([128, 128, 128, 255])
  expect(rgb(theme.entry.user.body)).toEqual([250, 178, 131, 255])
  expect(rgb(theme.entry.assistant.body)).toEqual([238, 238, 238, 255])
  expect(rgb(theme.entry.reasoning.body)).toEqual([128, 128, 128, 255])
  expect(rgb(theme.entry.tool.body)).toEqual([238, 238, 238, 255])
  expect(rgb(theme.entry.tool.start)).toEqual([128, 128, 128, 255])
  expect(rgb(theme.entry.error.body)).toEqual([224, 108, 117, 255])
  expect(rgbIndexed(theme.splash.left)).toEqual([128, 128, 128, 255])
  expect(rgbIndexed(theme.splash.right)).toEqual([238, 238, 238, 255])
  expect(rgbIndexed(theme.splash.leftShadow)).toEqual([28, 28, 28, 255])
  expect(rgbIndexed(theme.splash.rightShadow)).toEqual([38, 38, 38, 255])
  expect(rgb(theme.block.highlight)).toEqual([250, 178, 131, 255])
  expect(rgb(theme.block.warning)).toEqual([245, 167, 66, 255])
  expect(rgb(theme.block.text)).toEqual([238, 238, 238, 255])
  expect(rgb(theme.block.muted)).toEqual([128, 128, 128, 255])
  expect(rgb(theme.block.diffAdded)).toEqual([79, 214, 190, 255])
  expect(rgb(theme.block.diffRemoved)).toEqual([197, 59, 83, 255])
  expect(rgb(theme.block.diffHighlightAdded)).toEqual([184, 219, 135, 255])
  expect(rgb(theme.block.diffHighlightRemoved)).toEqual([226, 106, 117, 255])
  expect(rgb(theme.block.diffLineNumber)).toEqual([143, 143, 143, 255])
  expect(rgb(theme.block.diffAddedLineNumberBg)).toEqual([27, 43, 52, 255])
  expect(rgb(theme.block.diffRemovedLineNumberBg)).toEqual([45, 31, 38, 255])
  expect(rgb(theme.block.diffAddedBg)).toEqual([32, 48, 59, 255])
  expect(rgb(theme.block.diffRemovedBg)).toEqual([55, 34, 44, 255])
  expect(rgb(theme.block.diffContextBg)).toEqual([20, 20, 20, 255])

  // R44/J11: the diff fields resolve from run.block.diff.* elements whose
  // defaults equal the palette diff names, so the element path is lossless
  // for every v1 input.
  expect(rgb(theme.block.diffAdded)).toEqual(rgb(prepared.theme.diffAdded))
  expect(rgb(theme.block.diffRemoved)).toEqual(rgb(prepared.theme.diffRemoved))
  expect(rgb(theme.block.diffAddedBg)).toEqual(rgb(prepared.theme.diffAddedBg))
  expect(rgb(theme.block.diffRemovedBg)).toEqual(rgb(prepared.theme.diffRemovedBg))
  expect(rgb(theme.block.diffContextBg)).toEqual(rgb(prepared.theme.diffContextBg))
  expect(rgb(theme.block.diffHighlightAdded)).toEqual(rgb(prepared.theme.diffHighlightAdded))
  expect(rgb(theme.block.diffHighlightRemoved)).toEqual(rgb(prepared.theme.diffHighlightRemoved))
  expect(rgb(theme.block.diffLineNumber)).toEqual(rgb(prepared.theme.diffLineNumber))
  expect(rgb(theme.block.diffAddedLineNumberBg)).toEqual(rgb(prepared.theme.diffAddedLineNumberBg))
  expect(rgb(theme.block.diffRemovedLineNumberBg)).toEqual(rgb(prepared.theme.diffRemovedLineNumberBg))
})

test("resolves the generated system theme identically to the deleted v1 pipeline", async () => {
  const theme = await resolveRunTheme(renderer({ themeMode: "dark" }))

  try {
    // Golden values captured from the pre-refactor end-to-end pipeline
    // (generateSystem -> resolveTheme -> quantize -> splash -> map).
    expect(rgb(theme.background)).toEqual([26, 27, 38, 0])
    expect(rgb(theme.footer.highlight)).toEqual([125, 207, 255, 255])
    expect(rgb(theme.footer.selected)).toEqual([49, 50, 54, 255])
    expect(rgb(theme.footer.selectedText)).toEqual([26, 27, 38, 255])
    expect((theme.footer.selectedText as RGBA).intent).toBe("default")
    expect(rgb(theme.footer.warning)).toEqual([224, 175, 104, 255])
    expect(rgb(theme.footer.success)).toEqual([158, 206, 106, 255])
    expect(rgb(theme.footer.error)).toEqual([247, 118, 142, 255])
    expect(rgb(theme.footer.muted)).toEqual([168, 168, 168, 255])
    expect(rgb(theme.footer.text)).toEqual([192, 202, 245, 255])
    expect((theme.footer.text as RGBA).intent).toBe("default")
    expect(rgb(theme.footer.status)).toEqual([23, 24, 33, 255])
    expect(rgb(theme.footer.statusAccent)).toEqual([40, 41, 51, 255])
    expect(rgb(theme.footer.shade)).toEqual([39, 40, 47, 255])
    expect(rgb(theme.footer.surface)).toEqual([43, 44, 50, 255])
    expect(rgb(theme.footer.pane)).toEqual([49, 50, 54, 255])
    expect(rgb(theme.footer.border)).toEqual([79, 80, 87, 255])
    expect(rgb(theme.footer.line)).toEqual([47, 48, 52, 255])
    expect(rgbIndexed(theme.entry.system.body)).toEqual([224, 175, 104, 255])
    expect(rgbIndexed(theme.entry.user.body)).toEqual([125, 207, 255, 255])
    expect(rgb(theme.entry.assistant.body)).toEqual([192, 202, 245, 255])
    expect((theme.entry.assistant.body as RGBA).intent).toBe("default")
    expect(rgbIndexed(theme.entry.reasoning.body)).toEqual([224, 175, 104, 255])
    expect(rgb(theme.entry.tool.body)).toEqual([192, 202, 245, 255])
    expect(rgbIndexed(theme.entry.tool.start)).toEqual([224, 175, 104, 255])
    expect(rgbIndexed(theme.entry.error.body)).toEqual([247, 118, 142, 255])
    expect(rgbIndexed(theme.splash.left)).toEqual([224, 175, 104, 255])
    expect(rgbIndexed(theme.splash.right)).toEqual([192, 202, 245, 255])
    expect(rgbIndexed(theme.splash.leftShadow)).toEqual([21, 22, 30, 255])
    expect(rgbIndexed(theme.splash.rightShadow)).toEqual([21, 22, 30, 255])
    expect(rgbIndexed(theme.block.highlight)).toEqual([125, 207, 255, 255])
    expect(rgbIndexed(theme.block.warning)).toEqual([224, 175, 104, 255])
    expect(rgb(theme.block.text)).toEqual([192, 202, 245, 255])
    expect(rgbIndexed(theme.block.muted)).toEqual([224, 175, 104, 255])
    expect(rgbIndexed(theme.block.diffAdded)).toEqual([158, 206, 106, 255])
    expect(rgbIndexed(theme.block.diffRemoved)).toEqual([247, 118, 142, 255])
    expect(rgbIndexed(theme.block.diffHighlightAdded)).toEqual([158, 206, 106, 255])
    expect(rgbIndexed(theme.block.diffHighlightRemoved)).toEqual([247, 118, 142, 255])
    expect(rgbIndexed(theme.block.diffLineNumber)).toEqual([224, 175, 104, 255])
    expect(rgbIndexed(theme.block.diffAddedLineNumberBg)).toEqual([21, 22, 30, 255])
    expect(rgbIndexed(theme.block.diffRemovedLineNumberBg)).toEqual([21, 22, 30, 255])

    // themeMode drives the pick when OSC 11 is absent (defaultBackground null).
    const light = await resolveRunTheme(
      renderer({
        themeMode: "light",
        colors: {
          ...terminalColors(),
          defaultBackground: null,
          palette: ["#000000", ...terminalColors().palette.slice(1)],
        },
      }),
    )
    try {
      expect(rgb(light.footer.pane)).toEqual([0, 0, 0, 255])
      expect(rgb(light.footer.surface)).toEqual([0, 0, 0, 255])
      expect(rgb(light.footer.border)).toEqual([0, 0, 0, 255])
      expect(rgbIndexed(light.entry.system.body)).toEqual([21, 22, 30, 255])
      expect(rgbIndexed(light.block.muted)).toEqual([21, 22, 30, 255])
    } finally {
      light.block.syntax?.destroy()
      light.block.subtleSyntax?.destroy()
    }
  } finally {
    theme.block.syntax?.destroy()
    theme.block.subtleSyntax?.destroy()
  }
})

test("resolves a minimal v2 theme through the run.* elements", async () => {
  const prepared = await loadPrepared(v2Theme, "dark")
  const theme = runTheme(prepared, prepared, vgaIndexed, resolveElement)

  expect(rgb(theme.background)).toEqual([32, 32, 32, 255])
  expect(rgb(theme.footer.pane)).toEqual([16, 16, 16, 255])
  expect(rgb(theme.footer.text)).toEqual([255, 85, 0, 255])
  expect(rgb(theme.footer.selected)).toEqual([18, 52, 86, 255])
  expect(rgb(theme.entry.user.body)).toEqual([255, 85, 0, 255])
  expect(rgb(theme.entry.tool.start)).toEqual([0, 255, 0, 255])
  expect(rgb(theme.block.highlight)).toEqual([0, 0, 255, 255])
  expect(rgbIndexed(theme.splash.left)).toEqual([255, 0, 255, 255])

  // Unset run.* elements keep the default built-in palette (R24).
  expect(rgb(theme.footer.muted)).toEqual([128, 128, 128, 255])
  expect(rgb(theme.footer.highlight)).toEqual([250, 178, 131, 255])
  expect(rgb(theme.entry.assistant.body)).toEqual([238, 238, 238, 255])
  expect(rgbIndexed(theme.splash.right)).toEqual([238, 238, 238, 255])
})

test("resolves overridden run.block.diff.* elements on a v2 theme", async () => {
  const prepared = await loadPrepared(
    {
      $schema: "https://opencode.ai/theme.json",
      theme: {
        "run.block.diff.added-bg": { bg: "transparent" },
        "run.block.diff.line-number": { fg: "#010203" },
      },
    },
    "dark",
  )
  const theme = runTheme(prepared, prepared, vgaIndexed, resolveElement)

  // A v2 theme can clear a diff surface (R44, J11).
  expect(rgb(theme.block.diffAddedBg)).toEqual([0, 0, 0, 0])
  expect((theme.block.diffAddedBg as RGBA).a).toBe(0)
  expect(rgb(theme.block.diffLineNumber)).toEqual([1, 2, 3, 255])

  // Unset diff elements keep the default built-in palette (R24).
  const fallback = await loadPrepared(DEFAULT_THEMES.opencode, "dark")
  expect(rgb(theme.block.diffAdded)).toEqual(rgb(fallback.theme.diffAdded))
  expect(rgb(theme.block.diffRemovedBg)).toEqual(rgb(fallback.theme.diffRemovedBg))
  expect(rgb(theme.block.diffContextBg)).toEqual(rgb(fallback.theme.diffContextBg))
})

test("keeps the footer derivatives on the Configuration constants over overridden panes", async () => {
  const prepared = await loadPrepared(v2Theme, "dark")
  const theme = runTheme(prepared, prepared, vgaIndexed, resolveElement)

  // fade(run.footer.pane #101010, run.background #202020) with the recorded
  // fade parameters: shade 0.12/0.56/0.72, surface 0.18/0.76/0.9, line
  // 0.24/0.9/0.98 — over an opaque pane only the scale applies.
  expect(rgb(theme.footer.shade)).toEqual([23, 23, 23, 255])
  expect(rgb(theme.footer.surface)).toEqual([20, 20, 20, 255])
  expect(rgb(theme.footer.line)).toEqual([18, 18, 18, 255])
  // Status tints of the alpha-raised run.background #202020 (dark shares
  // 0.12 black, 0.06 white; luminance above the collapse threshold).
  expect(rgb(theme.footer.status)).toEqual([28, 28, 28, 255])
  expect(rgb(theme.footer.statusAccent)).toEqual([45, 45, 45, 255])
})

test("falls back to the default built-in theme when the source is rejected", async () => {
  const rejected = await loadPrepared({ theme: { "run.entry.user": { fg: "#ff00f" } } }, "dark")
  const fallback = await loadPrepared(DEFAULT_THEMES.opencode, "dark")

  expect(rgb(rejected.theme.primary)).toEqual(rgb(fallback.theme.primary))
  const theme = runTheme(rejected, rejected, vgaIndexed, resolveElement)
  const expected = runTheme(fallback, fallback, vgaIndexed, resolveElement)
  expect(rgb(theme.footer.highlight)).toEqual(rgb(expected.footer.highlight))
  expect(rgb(theme.entry.user.body)).toEqual(rgb(expected.entry.user.body))
  expect(rgb(theme.footer.pane)).toEqual(rgb(expected.footer.pane))
  expect(rgb(theme.block.diffAdded)).toEqual(rgb(expected.block.diffAdded))
  expect(rgb(theme.block.diffAddedBg)).toEqual(rgb(expected.block.diffAddedBg))
  expect(rgb(theme.block.diffRemovedLineNumberBg)).toEqual(rgb(expected.block.diffRemovedLineNumberBg))
})

test("keeps the fallback theme for a failed palette lookup", async () => {
  expect(await resolveRunTheme(renderer({ fail: true }))).toBe(RUN_THEME_FALLBACK)
})
