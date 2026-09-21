import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import { abbreviateHome } from "../../runtime"
import { useTuiPaths } from "../../context/runtime"
import { textAttributes } from "../../theme/catalog"

const id = "internal:sidebar-footer"

function View(props: { api: TuiPluginApi; sessionID: string }) {
  const paths = useTuiPaths()
  const has = createMemo(() =>
    props.api.state.provider.some(
      (item) => item.id !== "opencode" || Object.values(item.models).some((model) => model.cost?.input !== 0),
    ),
  )
  const done = createMemo(() => props.api.kv.get("dismissed_getting_started", false))
  const show = createMemo(() => !has() && !done())
  const path = createMemo(() => {
    const session = props.api.state.session.get(props.sessionID)
    const dir = session?.directory || props.api.state.path.directory || paths.cwd
    const out = abbreviateHome(dir, paths.home)
    const branch = session?.directory === props.api.state.path.directory ? props.api.state.vcs?.branch : undefined
    const text = branch ? out + ":" + branch : out
    const list = text.split("/")
    return {
      parent: list.slice(0, -1).join("/"),
      name: list.at(-1) ?? "",
    }
  })

  return (
    <box gap={1}>
      <Show when={show()}>
        <box
          backgroundColor={props.api.theme.element("sidebar.getting-started").bg}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          flexDirection="row"
          gap={1}
        >
          <text flexShrink={0} fg={props.api.theme.element("sidebar.text").fg}>
            ⬖
          </text>
          <box flexGrow={1} gap={1}>
            <box flexDirection="row" justifyContent="space-between">
              <text
                fg={props.api.theme.element("sidebar.strong").fg}
                attributes={textAttributes(props.api.theme.element("sidebar.strong").attributes)}
              >
                Getting started
              </text>
              <text
                fg={props.api.theme.element("sidebar.muted").fg}
                onMouseDown={() => props.api.kv.set("dismissed_getting_started", true)}
              >
                ✕
              </text>
            </box>
            <text fg={props.api.theme.element("sidebar.muted").fg}>
              OpenCode includes free models so you can start immediately.
            </text>
            <text fg={props.api.theme.element("sidebar.muted").fg}>
              Connect from 75+ providers to use other models, including Claude, GPT, Gemini etc
            </text>
            <box flexDirection="row" gap={1} justifyContent="space-between">
              <text fg={props.api.theme.element("sidebar.text").fg}>Connect provider</text>
              <text fg={props.api.theme.element("sidebar.muted").fg}>/connect</text>
            </box>
          </box>
        </box>
      </Show>
      <text>
        <span style={{ fg: props.api.theme.element("sidebar.muted").fg }}>{path().parent}/</span>
        <span style={{ fg: props.api.theme.element("sidebar.text").fg }}>{path().name}</span>
      </text>
      <text fg={props.api.theme.element("sidebar.muted").fg}>
        <span style={{ fg: props.api.theme.element("sidebar.status.ok").fg }}>•</span> <b>Open</b>
        <span style={{ fg: props.api.theme.element("sidebar.text").fg }}>
          <b>Code</b>
        </span>{" "}
        <span>{props.api.app.version}</span>
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_footer(_ctx, props) {
        return <View api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
