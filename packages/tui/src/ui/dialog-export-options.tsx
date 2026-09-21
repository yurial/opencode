import { TextareaRenderable } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { createStore } from "solid-js/store"
import { onMount, Show } from "solid-js"
import { useTuiConfig } from "../config"
import { useBindings } from "../keymap"
import { textAttributes } from "../theme/catalog"

export type DialogExportOptionsProps = {
  defaultFilename: string
  defaultThinking: boolean
  defaultToolDetails: boolean
  defaultAssistantMetadata: boolean
  defaultOpenWithoutSaving: boolean
  onConfirm?: (options: {
    filename: string
    thinking: boolean
    toolDetails: boolean
    assistantMetadata: boolean
    openWithoutSaving: boolean
  }) => void
  onCancel?: () => void
}

export function DialogExportOptions(props: DialogExportOptionsProps) {
  const dialog = useDialog()
  const { element } = useTheme()
  const tuiConfig = useTuiConfig()
  let textarea: TextareaRenderable
  const [store, setStore] = createStore({
    thinking: props.defaultThinking,
    toolDetails: props.defaultToolDetails,
    assistantMetadata: props.defaultAssistantMetadata,
    openWithoutSaving: props.defaultOpenWithoutSaving,
    active: "filename" as "filename" | "thinking" | "toolDetails" | "assistantMetadata" | "openWithoutSaving",
  })

  useBindings(() => ({
    bindings: [
      {
        key: "tab",
        desc: "Next export option",
        group: "Dialog",
        cmd: () => {
          const order: Array<"filename" | "thinking" | "toolDetails" | "assistantMetadata" | "openWithoutSaving"> = [
            "filename",
            "thinking",
            "toolDetails",
            "assistantMetadata",
            "openWithoutSaving",
          ]
          const currentIndex = order.indexOf(store.active)
          const nextIndex = (currentIndex + 1) % order.length
          setStore("active", order[nextIndex])
        },
      },
    ],
  }))

  useBindings(() => ({
    enabled: store.active !== "filename",
    bindings: [
      {
        key: "space",
        desc: "Toggle export option",
        group: "Dialog",
        cmd: () => {
          if (store.active === "thinking") setStore("thinking", !store.thinking)
          if (store.active === "toolDetails") setStore("toolDetails", !store.toolDetails)
          if (store.active === "assistantMetadata") setStore("assistantMetadata", !store.assistantMetadata)
          if (store.active === "openWithoutSaving") setStore("openWithoutSaving", !store.openWithoutSaving)
        },
      },
    ],
  }))

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={textAttributes(element("dialog.title").attributes)} fg={element("dialog.title").fg}>
          Export Options
        </text>
        <text fg={element("dialog.muted").fg} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <box>
          <text fg={element("dialog.body").fg}>Filename:</text>
        </box>
        <textarea
          onSubmit={() => {
            props.onConfirm?.({
              filename: textarea.plainText,
              thinking: store.thinking,
              toolDetails: store.toolDetails,
              assistantMetadata: store.assistantMetadata,
              openWithoutSaving: store.openWithoutSaving,
            })
          }}
          height={3}
          ref={(val: TextareaRenderable) => {
            textarea = val
            val.traits = { status: "FILENAME" }
          }}
          initialValue={props.defaultFilename}
          placeholder="Enter filename"
          placeholderColor={element("dialog.muted").fg}
          textColor={element("dialog.body").fg}
          focusedTextColor={element("dialog.body").fg}
          cursorColor={element("dialog.body").fg}
          cursorStyle={tuiConfig.cursor}
        />
      </box>
      <box flexDirection="column">
        <box
          flexDirection="row"
          gap={2}
          paddingLeft={1}
          backgroundColor={store.active === "thinking" ? element("dialog.export.option.active").bg : undefined}
          onMouseUp={() => setStore("active", "thinking")}
        >
          <text fg={store.active === "thinking" ? element("dialog.export.option.active").fg : element("dialog.muted").fg}>
            {store.thinking ? "[x]" : "[ ]"}
          </text>
          <text
            fg={store.active === "thinking" ? element("dialog.export.option.active").fg : element("dialog.export.option").fg}
          >
            Include thinking
          </text>
        </box>
        <box
          flexDirection="row"
          gap={2}
          paddingLeft={1}
          backgroundColor={store.active === "toolDetails" ? element("dialog.export.option.active").bg : undefined}
          onMouseUp={() => setStore("active", "toolDetails")}
        >
          <text fg={store.active === "toolDetails" ? element("dialog.export.option.active").fg : element("dialog.muted").fg}>
            {store.toolDetails ? "[x]" : "[ ]"}
          </text>
          <text
            fg={store.active === "toolDetails" ? element("dialog.export.option.active").fg : element("dialog.export.option").fg}
          >
            Include tool details
          </text>
        </box>
        <box
          flexDirection="row"
          gap={2}
          paddingLeft={1}
          backgroundColor={store.active === "assistantMetadata" ? element("dialog.export.option.active").bg : undefined}
          onMouseUp={() => setStore("active", "assistantMetadata")}
        >
          <text
            fg={store.active === "assistantMetadata" ? element("dialog.export.option.active").fg : element("dialog.muted").fg}
          >
            {store.assistantMetadata ? "[x]" : "[ ]"}
          </text>
          <text
            fg={
              store.active === "assistantMetadata"
                ? element("dialog.export.option.active").fg
                : element("dialog.export.option").fg
            }
          >
            Include assistant metadata
          </text>
        </box>
        <box
          flexDirection="row"
          gap={2}
          paddingLeft={1}
          backgroundColor={store.active === "openWithoutSaving" ? element("dialog.export.option.active").bg : undefined}
          onMouseUp={() => setStore("active", "openWithoutSaving")}
        >
          <text
            fg={store.active === "openWithoutSaving" ? element("dialog.export.option.active").fg : element("dialog.muted").fg}
          >
            {store.openWithoutSaving ? "[x]" : "[ ]"}
          </text>
          <text
            fg={
              store.active === "openWithoutSaving"
                ? element("dialog.export.option.active").fg
                : element("dialog.export.option").fg
            }
          >
            Open without saving
          </text>
        </box>
      </box>
      <Show when={store.active !== "filename"}>
        <text fg={element("dialog.muted").fg} paddingBottom={1}>
          Press <span style={{ fg: element("dialog.body").fg }}>space</span> to toggle,{" "}
          <span style={{ fg: element("dialog.body").fg }}>return</span> to confirm
        </text>
      </Show>
      <Show when={store.active === "filename"}>
        <text fg={element("dialog.muted").fg} paddingBottom={1}>
          Press <span style={{ fg: element("dialog.body").fg }}>return</span> to confirm,{" "}
          <span style={{ fg: element("dialog.body").fg }}>tab</span> for options
        </text>
      </Show>
    </box>
  )
}

DialogExportOptions.show = (
  dialog: DialogContext,
  defaultFilename: string,
  defaultThinking: boolean,
  defaultToolDetails: boolean,
  defaultAssistantMetadata: boolean,
  defaultOpenWithoutSaving: boolean,
) => {
  return new Promise<{
    filename: string
    thinking: boolean
    toolDetails: boolean
    assistantMetadata: boolean
    openWithoutSaving: boolean
  } | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogExportOptions
          defaultFilename={defaultFilename}
          defaultThinking={defaultThinking}
          defaultToolDetails={defaultToolDetails}
          defaultAssistantMetadata={defaultAssistantMetadata}
          defaultOpenWithoutSaving={defaultOpenWithoutSaving}
          onConfirm={(options) => resolve(options)}
          onCancel={() => resolve(null)}
        />
      ),
      () => resolve(null),
    )
  })
}
