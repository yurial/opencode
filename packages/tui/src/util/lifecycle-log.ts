import { appendFileSync } from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"

export type LifecycleLevel = "info" | "error"

// Severity constants of the tui-architecture/lifecycle-log records (R4.2,
// R4.5, R15.2-R15.5): lifecycle events at info, failures at error.
export const LIFECYCLE_LOG_INFO: LifecycleLevel = "info"
export const LIFECYCLE_LOG_ERROR: LifecycleLevel = "error"

// Appends one formatted record line to the shared opencode.log channel under
// Global.Path.log. Contract: never throws and never blocks the UI thread
// beyond a single small synchronous append — lifecycle records are rare, and
// synchronous writes make them durable before any host exit guard terminates
// the process. A record that cannot be written is dropped: a logging failure
// must never crash or redirect the app.
export function writeRecord(record: string, file: string = logFile()) {
  try {
    appendFileSync(file, record + "\n", { flag: "a" })
  } catch {
    return
  }
}

// Writes one lifecycle record, unless info records are suppressed by
// OPENCODE_LOG_LEVEL=ERROR — mirroring the minimum level of the shared
// channel's other writers (core minimumLogLevel). Error records always pass.
export function lifecycleLog(
  level: LifecycleLevel,
  message: string,
  fields: Record<string, unknown> = {},
  write: (record: string) => void = writeRecord,
) {
  if (level === LIFECYCLE_LOG_INFO && suppressInfo()) return
  write(formatRecord(level, message, fields))
}

// Renders one record as a single structured key=value line in the shared
// log's format: timestamp, level, scope, message, then the caller's fields.
// The scope=tui marker separates client records from server records in the
// shared file.
export function formatRecord(
  level: LifecycleLevel,
  message: string,
  fields: Record<string, unknown>,
  now: Date = new Date(),
) {
  return [
    `timestamp=${now.toISOString()}`,
    `level=${level}`,
    "scope=tui",
    `message=${formatValue(message)}`,
    ...Object.entries(fields).map(([key, value]) => `${key}=${formatValue(String(value))}`),
  ].join(" ")
}

function formatValue(value: string) {
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

// Compact single-line rendering of an arbitrary thrown value for log fields.
export function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function suppressInfo() {
  return process.env.OPENCODE_LOG_LEVEL?.toUpperCase() === "ERROR"
}

function logFile() {
  return path.join(Global.Path.log, "opencode.log")
}
