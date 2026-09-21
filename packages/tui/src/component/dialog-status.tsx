import { fileURLToPath } from "bun"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { For, Match, Switch, Show, createMemo } from "solid-js"
import { textAttributes } from "../theme/catalog"
import type { RGBA } from "@opentui/core"

export type DialogStatusProps = {}

export function DialogStatus() {
  const sync = useSync()
  const { element } = useTheme()
  const dialog = useDialog()

  const enabledFormatters = createMemo(() => sync.data.formatter.filter((f) => f.enabled))

  const plugins = createMemo(() => {
    const list = sync.data.config.plugin ?? []
    const result = list.map((item) => {
      const value = typeof item === "string" ? item : item[0]
      if (value.startsWith("file://")) {
        const path = fileURLToPath(value)
        const parts = path.split("/")
        const filename = parts.pop() || path
        if (!filename.includes(".")) return { name: filename }
        const basename = filename.split(".")[0]
        if (basename === "index") {
          const dirname = parts.pop()
          const name = dirname || basename
          return { name }
        }
        return { name: basename }
      }
      const index = value.lastIndexOf("@")
      if (index <= 0) return { name: value, version: "latest" }
      const name = value.substring(0, index)
      const version = value.substring(index + 1)
      return { name, version }
    })
    return result.toSorted((a, b) => a.name.localeCompare(b.name))
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={element("dialog.title").fg} attributes={textAttributes(element("dialog.title").attributes)}>
          Status
        </text>
        <text fg={element("dialog.muted").fg} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={Object.keys(sync.data.mcp).length > 0} fallback={<text fg={element("dialog.body").fg}>No MCP Servers</text>}>
        <box>
          <text fg={element("dialog.body").fg}>{Object.keys(sync.data.mcp).length} MCP Servers</text>
          <For each={Object.entries(sync.data.mcp)}>
            {([key, item]) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: (
                      {
                        connected: element("dialog.status.ok").fg,
                        failed: element("dialog.status.error").fg,
                        disabled: element("dialog.muted").fg,
                        needs_auth: element("dialog.status.warn").fg,
                        needs_client_registration: element("dialog.status.error").fg,
                      } as Record<string, RGBA>
                    )[item.status],
                  }}
                >
                  •
                </text>
                <text fg={element("dialog.body").fg} wrapMode="word">
                  <b>{key}</b>{" "}
                  <span style={{ fg: element("dialog.muted").fg }}>
                    <Switch fallback={item.status}>
                      <Match when={item.status === "connected"}>Connected</Match>
                      <Match when={item.status === "failed" && item}>{(val) => val().error}</Match>
                      <Match when={item.status === "disabled"}>Disabled in configuration</Match>
                      <Match when={(item.status as string) === "needs_auth"}>
                        Needs authentication (run: opencode mcp auth {key})
                      </Match>
                      <Match when={(item.status as string) === "needs_client_registration" && item}>
                        {(val) => (val() as { error: string }).error}
                      </Match>
                    </Switch>
                  </span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      {sync.data.lsp.length > 0 && (
        <box>
          <text fg={element("dialog.body").fg}>{sync.data.lsp.length} LSP Servers</text>
          <For each={sync.data.lsp}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: {
                      connected: element("dialog.status.ok").fg,
                      error: element("dialog.status.error").fg,
                    }[item.status],
                  }}
                >
                  •
                </text>
                <text fg={element("dialog.body").fg} wrapMode="word">
                  <b>{item.id}</b> <span style={{ fg: element("dialog.muted").fg }}>{item.root}</span>
                </text>
              </box>
            )}
          </For>
        </box>
      )}
      <Show when={enabledFormatters().length > 0} fallback={<text fg={element("dialog.body").fg}>No Formatters</text>}>
        <box>
          <text fg={element("dialog.body").fg}>{enabledFormatters().length} Formatters</text>
          <For each={enabledFormatters()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: element("dialog.status.ok").fg,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={element("dialog.body").fg}>
                  <b>{item.name}</b>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={plugins().length > 0} fallback={<text fg={element("dialog.body").fg}>No Plugins</text>}>
        <box>
          <text fg={element("dialog.body").fg}>{plugins().length} Plugins</text>
          <For each={plugins()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: element("dialog.status.ok").fg,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={element("dialog.body").fg}>
                  <b>{item.name}</b>
                  {item.version && <span style={{ fg: element("dialog.muted").fg }}> @{item.version}</span>}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
