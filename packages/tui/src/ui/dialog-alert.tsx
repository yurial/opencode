import { textAttributes } from "../theme/catalog"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { useBindings } from "../keymap"

export type DialogAlertProps = {
  title: string
  message: string
  onConfirm?: () => void
}

export function DialogAlert(props: DialogAlertProps) {
  const dialog = useDialog()
  const { element } = useTheme()

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: "Confirm alert",
        group: "Dialog",
        cmd: () => {
          props.onConfirm?.()
          dialog.clear()
        },
      },
    ],
  }))
  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={textAttributes(element("dialog.title").attributes)} fg={element("dialog.title").fg}>
          {props.title}
        </text>
        <text fg={element("dialog.muted").fg} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={element("dialog.muted").fg}>{props.message}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={element("dialog.action").bg}
          onMouseUp={() => {
            props.onConfirm?.()
            dialog.clear()
          }}
        >
          <text fg={element("dialog.action").fg}>ok</text>
        </box>
      </box>
    </box>
  )
}

DialogAlert.show = (dialog: DialogContext, title: string, message: string) => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <DialogAlert title={title} message={message} onConfirm={() => resolve()} />,
      () => resolve(),
    )
  })
}
