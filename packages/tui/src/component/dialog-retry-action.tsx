import { RGBA, TextAttributes } from "@opentui/core"
import open from "open"
import { createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { Link } from "../ui/link"
import { BgPulse } from "./bg-pulse"
import { textAttributes } from "../theme/catalog"
import { useBindings } from "../keymap"

const GO_URL = "https://opencode.ai/go"
const PAD_X = 3
const PAD_TOP_OUTER = 1
const FOREGROUND_ALPHA = 186

export type DialogRetryActionProps = {
  title: string
  message: string
  label: string
  link?: string
  onClose?: (dontShowAgain?: boolean) => void
}

function runAction(props: DialogRetryActionProps, dialog: ReturnType<typeof useDialog>) {
  if (props.link) open(props.link).catch(() => {})
  props.onClose?.()
  dialog.clear()
}

function dismiss(props: DialogRetryActionProps, dialog: ReturnType<typeof useDialog>) {
  props.onClose?.(true)
  dialog.clear()
}

function panelOverlay(color: RGBA) {
  const [r, g, b] = color.toInts()
  return RGBA.fromInts(r, g, b, FOREGROUND_ALPHA)
}

export function DialogRetryAction(props: DialogRetryActionProps) {
  const dialog = useDialog()
  const { element } = useTheme()
  // The retry overlay paints `dialog.retry`'s background at the fixed
  // foreground alpha so the BgPulse underneath stays visible.
  const retryOverlay = () => panelOverlay(element("dialog.retry").bg)
  const showGoTreatment = () => props.link === GO_URL
  const textBg = () => (showGoTreatment() ? retryOverlay() : undefined)
  const [selected, setSelected] = createSignal<"dismiss" | "action">("action")

  useBindings(() => ({
    bindings: [
      {
        key: "left",
        desc: "Previous retry option",
        group: "Dialog",
        cmd: () => setSelected((value) => (value === "action" ? "dismiss" : "action")),
      },
      {
        key: "right",
        desc: "Next retry option",
        group: "Dialog",
        cmd: () => setSelected((value) => (value === "action" ? "dismiss" : "action")),
      },
      {
        key: "tab",
        desc: "Next retry option",
        group: "Dialog",
        cmd: () => setSelected((value) => (value === "action" ? "dismiss" : "action")),
      },
      {
        key: "return",
        desc: "Confirm retry option",
        group: "Dialog",
        cmd: () => {
          if (selected() === "action") runAction(props, dialog)
          else dismiss(props, dialog)
        },
      },
    ],
  }))

  return (
    <box>
      {showGoTreatment() ? (
        <box position="absolute" top={-PAD_TOP_OUTER} left={0} right={0} bottom={0} zIndex={0}>
          <BgPulse />
        </box>
      ) : null}
      <box zIndex={1} paddingLeft={PAD_X} paddingRight={PAD_X} paddingBottom={1} gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text
            attributes={textAttributes(element("dialog.title").attributes)}
            fg={element("dialog.title").fg}
            bg={textBg()}
          >
            {props.title}
          </text>
          <text fg={element("dialog.muted").fg} bg={textBg()} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
        <box gap={0}>
          <text fg={element("dialog.muted").fg} bg={textBg()}>
            {props.message}
          </text>
        </box>
        {props.link ? (
          showGoTreatment() ? (
            <box alignItems="center" justifyContent="flex-end" height={7} paddingBottom={1}>
              <Link href={props.link} fg={element("dialog.link").fg} bg={textBg()} wrapMode="none" />
            </box>
          ) : (
            <box width="100%" flexDirection="row" justifyContent="center" paddingBottom={1}>
              <Link href={props.link} fg={element("dialog.link").fg} wrapMode="none" />
            </box>
          )
        ) : (
          <box paddingBottom={1} />
        )}
        <box flexDirection="row" justifyContent="space-between">
          <box
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={selected() === "dismiss" ? element("dialog.action").bg : RGBA.fromInts(0, 0, 0, 0)}
            onMouseOver={() => setSelected("dismiss")}
            onMouseUp={() => dismiss(props, dialog)}
          >
            <text
              fg={selected() === "dismiss" ? element("dialog.action").fg : element("dialog.muted").fg}
              bg={selected() === "dismiss" ? undefined : textBg()}
              attributes={selected() === "dismiss" ? TextAttributes.BOLD : undefined}
            >
              don't show again
            </text>
          </box>
          <box
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={selected() === "action" ? element("dialog.action").bg : RGBA.fromInts(0, 0, 0, 0)}
            onMouseOver={() => setSelected("action")}
            onMouseUp={() => runAction(props, dialog)}
          >
            <text
              fg={selected() === "action" ? element("dialog.action").fg : element("dialog.body").fg}
              bg={selected() === "action" ? undefined : textBg()}
              attributes={selected() === "action" ? TextAttributes.BOLD : undefined}
            >
              {props.label}
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}

DialogRetryAction.show = (
  dialog: DialogContext,
  props: Pick<DialogRetryActionProps, "title" | "message" | "label" | "link">,
) => {
  return new Promise<boolean>((resolve) => {
    dialog.replace(
      () => <DialogRetryAction {...props} onClose={(dontShow) => resolve(dontShow ?? false)} />,
      () => resolve(false),
    )
  })
}
