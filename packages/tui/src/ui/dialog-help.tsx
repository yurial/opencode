import { textAttributes } from "../theme/catalog"
import { useTheme } from "../context/theme"
import { useDialog } from "./dialog"
import { useBindings, useCommandShortcut } from "../keymap"

export function DialogHelp() {
  const dialog = useDialog()
  const { element } = useTheme()
  const commandShortcut = useCommandShortcut("command.palette.show")

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
      { key: "escape", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={textAttributes(element("dialog.title").attributes)} fg={element("dialog.title").fg}>
          Help
        </text>
        <text fg={element("dialog.muted").fg} onMouseUp={() => dialog.clear()}>
          esc/enter
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={element("dialog.muted").fg}>
          Press {commandShortcut()} to see all available actions and commands in any context.
        </text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={element("dialog.action").bg}
          onMouseUp={() => dialog.clear()}
        >
          <text fg={element("dialog.action").fg}>ok</text>
        </box>
      </box>
    </box>
  )
}
