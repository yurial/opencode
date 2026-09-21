import { RGBA } from "@opentui/core"
import { For, type JSX } from "solid-js"
import { textAttributes } from "../theme/catalog"
import { tint, useTheme } from "../context/theme"
import { logo } from "../logo"

export function Logo() {
  const { theme, element } = useTheme()

  const renderLine = (line: string, fg: RGBA, attributes: number): JSX.Element[] => {
    // logo.shadow contract: the catalog row has no static default because the
    // shadow blends the background with each half's own foreground. A
    // transparent (unset) element resolves to the computed per-half tint
    // (logo-shadow-alpha 0.25); an explicit bg override paints both halves.
    const override = element("logo.shadow").bg
    const shadow = override.a === 0 ? tint(theme.background, fg, 0.25) : override
    return Array.from(line).map((char) => {
      if (char === "_") {
        return (
          <text fg={fg} bg={shadow} attributes={attributes} selectable={false}>
            {" "}
          </text>
        )
      }
      if (char === "^") {
        return (
          <text fg={fg} bg={shadow} attributes={attributes} selectable={false}>
            ▀
          </text>
        )
      }
      if (char === "~") {
        return (
          <text fg={shadow} attributes={attributes} selectable={false}>
            ▀
          </text>
        )
      }
      if (char === ",") {
        return (
          <text fg={shadow} attributes={attributes} selectable={false}>
            ▄
          </text>
        )
      }
      return (
        <text fg={fg} attributes={attributes} selectable={false}>
          {char}
        </text>
      )
    })
  }

  return (
    <box>
      <For each={logo.left}>
        {(line, index) => (
          <box flexDirection="row" gap={1}>
            <box flexDirection="row">{renderLine(line, element("logo.left").fg, textAttributes(element("logo.left").attributes))}</box>
            <box flexDirection="row">
              {renderLine(logo.right[index()], element("logo.right").fg, textAttributes(element("logo.right").attributes))}
            </box>
          </box>
        )}
      </For>
    </box>
  )
}
