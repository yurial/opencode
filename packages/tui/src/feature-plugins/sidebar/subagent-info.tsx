import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import { textAttributes } from "../../theme/catalog"

const id = "internal:sidebar-subagent-info"

// Subagent-info block (specs/tui-architecture.md R20, specs/tui-plugins.md):
// the first block of the session sidebar (`sidebar_content`, order 50)
// describing the viewed subagent session — its title, agent, provider model,
// and live status — so a subagent view identifies itself the way the root
// view is identified by the sidebar title area. Root sessions never render
// it.
//
// Contract: the slot renderer receives the standard slot props
// `{ session_id }` and reads everything through the plugin api state, keyed
// by that id: the session from `api.state.session.get(session_id)`, the live
// status from `api.state.session.status(session_id)` (the `session_status`
// store shape: `{ type: "idle" } | { type: "busy" } | { type: "retry",
// attempt, message }`).
//
// Render rules:
// - No session in the store for `session_id`, or a session without
//   `parentID` (a root session): renders nothing.
// - Subagent session (`parentID` set): a "Subagent" header, the session
//   title, then optional rows — the agent name when `session.agent` is set,
//   the model as `providerID/id` when `session.model` is set, and the status
//   row always (a missing status reads as idle).
//
// Edge cases: the status row survives every status shape — `idle` (or no
// stored status) renders "Idle", `busy` renders "Running", `retry` renders
// the attempt count; unknown extras of the status union are ignored. Colors
// come from the shared `sidebar.strong` / `sidebar.muted` theme elements, so
// no new theme elements are introduced.
function View(props: { api: TuiPluginApi; session_id: string }) {
  const strong = () => props.api.theme.element("sidebar.strong")
  const muted = () => props.api.theme.element("sidebar.muted")
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const status = createMemo(() => props.api.state.session.status(props.session_id))

  const label = createMemo(() => {
    const value = status()
    if (value?.type === "busy") return "Running"
    if (value?.type === "retry") return `Retrying (attempt ${value.attempt})`
    return "Idle"
  })

  return (
    <Show when={session()?.parentID}>
      <box>
        <text fg={strong().fg} attributes={textAttributes(strong().attributes)}>
          Subagent
        </text>
        <text fg={muted().fg}>{session()!.title}</text>
        <Show when={session()!.agent}>
          <text fg={muted().fg}>{`Agent: ${session()!.agent}`}</text>
        </Show>
        <Show when={session()!.model}>
          <text fg={muted().fg}>{`Model: ${session()!.model!.providerID}/${session()!.model!.id}`}</text>
        </Show>
        <text fg={muted().fg}>{`Status: ${label()}`}</text>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 50,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
