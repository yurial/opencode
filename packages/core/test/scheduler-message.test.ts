import { describe, expect, test } from "bun:test"
import { SchedulerMessage } from "@opencode-ai/core/scheduler/message"

const utc = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millis = 0,
) => Date.UTC(year, month - 1, day, hour, minute, second, millis)

describe("SchedulerMessage.timestamp", () => {
  test("renders whole-second instants without the millisecond part", () => {
    expect(SchedulerMessage.timestamp(utc(2026, 10, 24, 13, 0, 0))).toBe("2026-10-24T13:00:00Z")
    expect(SchedulerMessage.timestamp(utc(2026, 1, 2, 3, 4, 5))).toBe("2026-01-02T03:04:05Z")
  })

  test("keeps the millisecond part for sub-second instants", () => {
    expect(SchedulerMessage.timestamp(utc(2026, 10, 24, 13, 0, 0, 250))).toBe("2026-10-24T13:00:00.250Z")
  })
})

describe("SchedulerMessage.spec", () => {
  test("renders the cron form of a recurring schedule", () => {
    expect(SchedulerMessage.spec({ cron: "*/30 * * * *" })).toBe("*/30 * * * *")
  })

  test("renders the stored UTC datetime of a one-shot", () => {
    expect(SchedulerMessage.spec({ at: utc(2026, 11, 2, 6) })).toBe("2026-11-02T06:00:00Z")
  })
})

describe("SchedulerMessage.fired", () => {
  test("follows the fired-message grammar", () => {
    // Spec E6.6.
    expect(
      SchedulerMessage.fired({
        scheduledFireAt: utc(2026, 10, 24, 13, 0),
        id: "sch_example",
        spec: "*/30 * * * *",
        message: "check CI status",
        catchUp: false,
      }),
    ).toBe("2026-10-24T13:00:00Z fired schedule id sch_example */30 * * * *: check CI status")
  })

  test("carries the converted cron form for schedules created from every", () => {
    // Spec E6.7: an add of every 1d fires with the spec 0 0 * * *.
    const text = SchedulerMessage.fired({
      scheduledFireAt: utc(2026, 10, 25, 0, 0),
      id: "sch_daily",
      spec: "0 0 * * *",
      message: "standup",
      catchUp: false,
    })
    expect(text).toBe("2026-10-25T00:00:00Z fired schedule id sch_daily 0 0 * * *: standup")
  })

  test("appends the catch-up marker exactly on a catch-up fire", () => {
    const base = {
      scheduledFireAt: utc(2026, 10, 24, 13, 0),
      id: "sch_example",
      spec: "0 * * * *",
      message: "check CI status",
    }
    // Spec E7: one catch-up fire with timestamp 13:00 and the marker.
    expect(SchedulerMessage.fired({ ...base, catchUp: true })).toBe(
      "2026-10-24T13:00:00Z fired schedule id sch_example 0 * * * *: check CI status" +
        " [catch-up: delivered after the scheduled fire time]",
    )
    expect(SchedulerMessage.fired({ ...base, catchUp: false })).not.toContain("catch-up")
  })
})

describe("SchedulerMessage.result lines", () => {
  const entry = {
    id: "sch_example",
    spec: "*/30 * * * *",
    nextFireAt: utc(2026, 10, 24, 13, 0),
  }

  test("the add result echoes id, spec, and next due time", () => {
    const line = SchedulerMessage.added(entry)
    expect(line).toContain("sch_example")
    expect(line).toContain("*/30 * * * *")
    expect(line).toContain("2026-10-24T13:00:00Z")
  })

  test("the list line carries id, spec, next due time, and message", () => {
    const line = SchedulerMessage.listed({ ...entry, message: "check CI status" })
    expect(line).toContain("sch_example")
    expect(line).toContain("*/30 * * * *")
    expect(line).toContain("2026-10-24T13:00:00Z")
    expect(line).toContain("check CI status")
  })

  test("the remove result confirms the removed id", () => {
    expect(SchedulerMessage.removed("sch_example")).toContain("sch_example")
  })
})
