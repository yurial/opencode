import { RGBA } from "@opentui/core"
import { For, type JSX } from "solid-js"
import { textAttributes } from "../theme/catalog"
import { tint, useTheme } from "../context/theme"
import { logo } from "../logo"

export function Logo() {
  const { theme, element } = useTheme()

  const renderLine = (line: string, fg: RGBA, attributes: number): JSX.Element[] => {
    const shadow = tint(theme.background, fg, 0.25)
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
