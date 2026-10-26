import stripAnsi from "strip-ansi"

// tmux renames a window (tab) only through the screen-legacy sequence
// ESC k <name> ESC \ (with allow-rename on); the OSC 0/2 pane title never
// renames the window. Sanitize the title so control characters cannot
// terminate or forge the sequence.
const TAB_NAME_LIMIT = 60

export function tmuxTabSequence(input: string | undefined) {
  const name = stripAnsi(input ?? "")
    .replace(/[ \t]*[\r\n]+[ \t]*/g, " ")
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .trim()
  if (!name) return
  return `\x1bk${Array.from(name).slice(0, TAB_NAME_LIMIT).join("")}\x1b\\`
}
