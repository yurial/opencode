import { createMemo, createSignal, For } from "solid-js"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useRoute } from "../context/route"
import { useLocal } from "../context/local"
import { useClipboard } from "../context/clipboard"
import { useToast } from "../ui/toast"
import { useBindings } from "../keymap"
import { describeOS, describeTerminal } from "../util/system"
import { textAttributes } from "../theme/catalog"

export function DialogDebug() {
  const { element } = useTheme()
  const dialog = useDialog()
  const route = useRoute()
  const local = useLocal()
  const clipboard = useClipboard()
  const toast = useToast()
  const [copied, setCopied] = createSignal(false)

  dialog.setSize("large")

  const entries = createMemo(() => {
    const model = local.model.current()
    return [
      { label: "Version", value: `${InstallationVersion} (${InstallationChannel})` },
      { label: "Date", value: new Date().toISOString() },
      { label: "OS", value: describeOS() },
      { label: "Terminal", value: describeTerminal() },
      { label: "Session ID", value: route.data.type === "session" ? route.data.sessionID : "n/a" },
      { label: "Model", value: model ? `${model.providerID}/${model.modelID}` : "n/a" },
    ]
  })

  const copy = () => {
    const text = entries()
      .map((entry) => `${entry.label}: ${entry.value}`)
      .join("\n")
    void clipboard
      .write?.(text)
      .then(() => {
        setCopied(true)
        toast.show({ message: "Debug info copied to clipboard", variant: "info" })
      })
      .catch(toast.error)
  }

  useBindings(() => ({
    bindings: [{ key: "return", desc: "Copy debug info", group: "Dialog", cmd: copy }],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={element("dialog.title").fg} attributes={textAttributes(element("dialog.title").attributes)}>
          Debug
        </text>
        <text fg={element("dialog.muted").fg} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      {/* No click-to-copy here: releasing a mouse selection must trigger the
          global copy-on-select so users can copy a single value, e.g. the session id. */}
      <box>
        <For each={entries()}>
          {(entry) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={element("dialog.muted").fg}>
                {entry.label.padEnd(10)}
              </text>
              <text fg={element("dialog.body").fg} wrapMode="word">
                {entry.value}
              </text>
            </box>
          )}
        </For>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={element("dialog.muted").fg}>Share this when reporting an issue.</text>
        <text onMouseUp={copy}>
          <span style={{ fg: copied() ? element("dialog.debug.copied").fg : element("dialog.body").fg }}>
            <b>{copied() ? "✓ copied" : "copy"}</b>{" "}
          </span>
          <span style={{ fg: element("dialog.muted").fg }}>enter</span>
        </text>
      </box>
    </box>
  )
}
