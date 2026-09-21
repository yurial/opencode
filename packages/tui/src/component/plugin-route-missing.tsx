import { useTheme } from "../context/theme"

export function PluginRouteMissing(props: { id: string; onHome: () => void }) {
  const { element } = useTheme()

  return (
    <box width="100%" height="100%" alignItems="center" justifyContent="center" flexDirection="column" gap={1}>
      <text fg={element("dialog.route.warning").fg}>Unknown plugin route: {props.id}</text>
      <box onMouseUp={props.onHome} backgroundColor={element("dialog.route.home").bg} paddingLeft={1} paddingRight={1}>
        <text fg={element("dialog.route.home").fg}>go home</text>
      </box>
    </box>
  )
}
