import fs from "fs"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"

export type LifecycleRecord = { level: string; message: string; fields: Record<string, string> }

// Points the tui lifecycle channel at a fresh temporary opencode.log and
// returns a synchronous reader for it; dispose() restores the real log
// directory. Records are written synchronously by the channel, so reads after
// an await observe every record of the awaited step.
export function captureLifecycleLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-lifecycle-"))
  const original = Global.Path.log
  Global.Path.log = dir
  const file = path.join(dir, "opencode.log")
  return {
    file,
    records(): LifecycleRecord[] {
      if (!fs.existsSync(file)) return []
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map(parseRecord)
    },
    dispose() {
      Global.Path.log = original
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function parseRecord(line: string): LifecycleRecord {
  const fields: Record<string, string> = {}
  for (const token of tokenize(line)) {
    const [key, value] = splitToken(token)
    fields[key] = value
  }
  return { level: fields.level ?? "", message: fields.message ?? "", fields }
}

function splitToken(token: string): [string, string] {
  const eq = token.indexOf("=")
  if (eq < 0) return [token, ""]
  const value = token.slice(eq + 1)
  return [token.slice(0, eq), value.includes("\\") ? JSON.parse(`"${value}"`) : value]
}

function tokenize(line: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quoted = false
  let escaped = false
  for (const char of line) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\") {
      current += char
      escaped = true
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (char === " " && !quoted) {
      if (current) tokens.push(current)
      current = ""
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}
