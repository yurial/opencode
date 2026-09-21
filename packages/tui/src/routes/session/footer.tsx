import { createMemo, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/use-connected"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"

export function Footer() {
  const { element } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const mcp = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).some((x) => x.status === "failed"))
  const lsp = createMemo(() => Object.keys(sync.data.lsp))
  const permissions = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.permission[route.data.sessionID] ?? []
  })
  const directory = useDirectory()
  const connected = useConnected()

  const [store, setStore] = createStore({
    welcome: false,
  })

  onMount(() => {
    // Track all timeouts to ensure proper cleanup
    const timeouts: ReturnType<typeof setTimeout>[] = []

    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeouts.push(setTimeout(() => tick(), 5000))
        return
      }

      if (store.welcome) {
        setStore("welcome", false)
        timeouts.push(setTimeout(() => tick(), 10_000))
        return
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))

    onCleanup(() => {
      timeouts.forEach(clearTimeout)
    })
  })

  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <text fg={element("footer.muted").fg}>{directory()}</text>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <Switch>
          <Match when={store.welcome}>
            <text fg={element("footer.text").fg}>
              Get started <span style={{ fg: element("footer.muted").fg }}>/connect</span>
            </text>
          </Match>
          <Match when={connected()}>
            <Show when={permissions().length > 0}>
              <text fg={element("footer.permission").fg}>
                <span style={{ fg: element("footer.permission").fg }}>△</span> {permissions().length} Permission
                {permissions().length > 1 ? "s" : ""}
              </text>
            </Show>
            <text fg={element("footer.text").fg}>
              <span style={{ fg: lsp().length > 0 ? element("footer.status.ok").fg : element("footer.muted").fg }}>
                •
              </span>{" "}
              {lsp().length} LSP
            </text>
            <Show when={mcp()}>
              <text fg={element("footer.text").fg}>
                <Switch>
                  <Match when={mcpError()}>
                    <span style={{ fg: element("footer.status.error").fg }}>⊙ </span>
                  </Match>
                  <Match when={true}>
                    <span style={{ fg: element("footer.status.ok").fg }}>⊙ </span>
                  </Match>
                </Switch>
                {mcp()} MCP
              </text>
            </Show>
            <text fg={element("footer.muted").fg}>/status</text>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
