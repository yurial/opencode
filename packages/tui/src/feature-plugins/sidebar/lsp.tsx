import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal } from "solid-js"
import { textAttributes } from "../../theme/catalog"

const id = "internal:sidebar-lsp"

function View(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const list = createMemo(() => props.api.state.lsp())
  const off = createMemo(() => !props.api.state.config.lsp)

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
        <Show when={list().length > 2}>
          <text fg={props.api.theme.element("sidebar.text").fg}>{open() ? "▼" : "▶"}</text>
        </Show>
        <text
          fg={props.api.theme.element("sidebar.strong").fg}
          attributes={textAttributes(props.api.theme.element("sidebar.strong").attributes)}
        >
          LSP
        </text>
      </box>
      <Show when={list().length <= 2 || open()}>
        <Show when={list().length === 0}>
          <text fg={props.api.theme.element("sidebar.muted").fg}>
            {off() ? "LSPs are disabled" : "LSPs will activate as files are read"}
          </text>
        </Show>
        <For each={list()}>
          {(item) => (
            <box flexDirection="row" gap={1}>
              <text
                flexShrink={0}
                style={{
                  fg:
                    item.status === "connected"
                      ? props.api.theme.element("sidebar.status.ok").fg
                      : props.api.theme.element("sidebar.status.error").fg,
                }}
              >
                •
              </text>
              <text fg={props.api.theme.element("sidebar.muted").fg}>
                {item.id} {item.root}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 300,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
