import { useTheme } from "../context/theme"

export type WorkspaceStatus = "connected" | "connecting" | "disconnected" | "error"

export function WorkspaceLabel(props: { type: string; name: string; status?: WorkspaceStatus; icon?: boolean }) {
  // WorkspaceLabel renders inside the session sidebar, so the sidebar zone's
  // status/text elements govern its channels.
  const { element } = useTheme()
  const color = () => {
    if (props.status === "connected") return element("sidebar.status.ok").fg
    if (props.status === "error") return element("sidebar.status.error").fg
    return element("sidebar.muted").fg
  }

  return (
    <>
      {props.icon ? <span style={{ fg: color() }}>● </span> : undefined}
      <span style={{ fg: element("sidebar.text").fg }}>{props.name}</span>{" "}
      <span style={{ fg: element("sidebar.muted").fg }}>({props.type})</span>
    </>
  )
}
