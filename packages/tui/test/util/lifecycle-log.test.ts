import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  formatError,
  formatRecord,
  lifecycleLog,
  LIFECYCLE_LOG_ERROR,
  LIFECYCLE_LOG_INFO,
  writeRecord,
} from "../../src/util/lifecycle-log"

describe("formatRecord", () => {
  test("renders a single structured key=value line", () => {
    const record = formatRecord(LIFECYCLE_LOG_INFO, "tui exit", { cause: "SIGHUP", code: 0 }, new Date(0))
    expect(record).toBe(
      "timestamp=1970-01-01T00:00:00.000Z level=info scope=tui message=\"tui exit\" cause=SIGHUP code=0",
    )
  })

  test("quotes values that are not plain tokens", () => {
    const record = formatRecord(LIFECYCLE_LOG_ERROR, "event handler failed", { error: "boom boom" }, new Date(0))
    expect(record).toBe(
      "timestamp=1970-01-01T00:00:00.000Z level=error scope=tui message=\"event handler failed\" error=\"boom boom\"",
    )
  })
})

describe("lifecycleLog", () => {
  test("writes an info record through the sink", () => {
    const written: string[] = []
    lifecycleLog(LIFECYCLE_LOG_INFO, "event stream connect", { attempt: 0 }, (record) => written.push(record))
    expect(written).toHaveLength(1)
    expect(written[0]).toContain("level=info scope=tui message=\"event stream connect\" attempt=0")
  })

  test("suppresses info records at OPENCODE_LOG_LEVEL=ERROR", () => {
    const original = process.env.OPENCODE_LOG_LEVEL
    process.env.OPENCODE_LOG_LEVEL = "ERROR"
    try {
      const written: string[] = []
      const write = (record: string) => written.push(record)
      lifecycleLog(LIFECYCLE_LOG_INFO, "tui exit", {}, write)
      lifecycleLog(LIFECYCLE_LOG_ERROR, "event handler failed", {}, write)
      expect(written).toHaveLength(1)
      expect(written[0]).toContain("level=error")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_LOG_LEVEL
      else process.env.OPENCODE_LOG_LEVEL = original
    }
  })

  test("writes info records at the default and lower levels", () => {
    const original = process.env.OPENCODE_LOG_LEVEL
    process.env.OPENCODE_LOG_LEVEL = "DEBUG"
    try {
      const written: string[] = []
      lifecycleLog(LIFECYCLE_LOG_INFO, "tui exit", {}, (record) => written.push(record))
      expect(written).toHaveLength(1)
    } finally {
      if (original === undefined) delete process.env.OPENCODE_LOG_LEVEL
      else process.env.OPENCODE_LOG_LEVEL = original
    }
  })
})

describe("writeRecord", () => {
  test("appends the record line to the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-log-"))
    const file = path.join(dir, "opencode.log")
    writeRecord("first", file)
    writeRecord("second", file)
    expect(fs.readFileSync(file, "utf8")).toBe("first\nsecond\n")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("drops the record instead of throwing when the file is unwritable", () => {
    const file = path.join(os.tmpdir(), "lifecycle-log-missing-dir", "opencode.log")
    expect(() => writeRecord("first", file)).not.toThrow()
  })
})

describe("formatError", () => {
  test("uses the message of an Error", () => {
    expect(formatError(new Error("boom"))).toBe("boom")
  })

  test("stringifies non-Error values", () => {
    expect(formatError("plain failure")).toBe("plain failure")
  })
})
