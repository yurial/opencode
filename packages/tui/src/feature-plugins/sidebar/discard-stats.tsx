import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { collectDiscardedPartIds, discardedTokenTotal, formatCompactTokens } from "../../util/discard-context"
import { textAttributes } from "../../theme/catalog"
import { createMemo, Show } from "solid-js"

const id = "internal:sidebar-discard-stats"

// Discard-statistics block (specs/discard-context.md R9): three rows derived
// from the durable session history alone through the sync-backed plugin
// state — unique marked parts, the discarded-token-total in the compact
// format (with "~" when a partial share made it estimated, R7.8), and the
// discard-call count. Marked ids are never rendered, and the block hides
// while nothing is marked (R9.4). Colors come from the sidebar.discard.*
// elements (R54): the header takes its foreground and attributes from
// sidebar.discard.header, every row its foreground from sidebar.discard.row.
function View(props: { api: TuiPluginApi; session_id: string }) {
  const header = () => props.api.theme.element("sidebar.discard.header")
  const row = () => props.api.theme.element("sidebar.discard.row")
  const messages = createMemo(() => props.api.state.session.messages(props.session_id))
  const parts = createMemo(() => messages().flatMap((message) => props.api.state.part(message.id)))
  const markedIds = createMemo(() => collectDiscardedPartIds(parts()))
  const marked = createMemo(() => parts().filter((part) => markedIds().has(part.id)))
  const calls = createMemo(
    () => parts().filter((part) => part.type === "tool" && part.tool === "discard_context").length,
  )
  const tokens = createMemo(() => discardedTokenTotal(messages(), (messageID) => props.api.state.part(messageID)))

  return (
    <Show when={marked().length > 0}>
      <box>
        <text fg={header().fg} attributes={textAttributes(header().attributes)}>
          Discard
        </text>
        <text fg={row().fg}>Discarded: {marked().length} part{marked().length === 1 ? "" : "s"}</text>
        <text fg={row().fg}>
          {tokens().estimated ? "~" : ""}
          {formatCompactTokens(tokens().total)} tokens
        </text>
        <text fg={row().fg}>{calls()} call{calls() === 1 ? "" : "s"}</text>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
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
