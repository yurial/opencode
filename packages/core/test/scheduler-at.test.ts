import { describe, expect, test } from "bun:test"
import { SchedulerAt } from "@opencode-ai/core/scheduler/at"

const utc = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millis = 0,
) => Date.UTC(year, month - 1, day, hour, minute, second, millis)

const offset = (millis: number) => () => millis
// A zone that flips from +02:00 to +03:00 at 2026-10-25T00:00:00Z.
const dstZone = (time: number) => (time >= utc(2026, 10, 25) ? 3 * 3_600_000 : 2 * 3_600_000)

describe("SchedulerAt.parse", () => {
  test("resolves a zoned datetime to the UTC equivalent of its offset", () => {
    expect(SchedulerAt.parse("2026-11-02T09:00:00+03:00", offset(0))).toBe(utc(2026, 11, 2, 6))
    expect(SchedulerAt.parse("2026-11-02T09:00:00-05:00", offset(0))).toBe(utc(2026, 11, 2, 14))
    expect(SchedulerAt.parse("2026-11-02T09:00:00Z", offset(5 * 3_600_000))).toBe(utc(2026, 11, 2, 9))
    expect(SchedulerAt.parse("2026-11-02T09:00:00z", offset(5 * 3_600_000))).toBe(utc(2026, 11, 2, 9))
  })

  test("resolves a naive datetime in the injected process timezone", () => {
    const plusThree = offset(3 * 3_600_000)
    expect(SchedulerAt.parse("2026-11-02T09:00:00", plusThree)).toBe(utc(2026, 11, 2, 6))
    const minusFive = offset(-5 * 3_600_000)
    expect(SchedulerAt.parse("2026-11-02T09:00:00", minusFive)).toBe(utc(2026, 11, 2, 14))
  })

  test("applies the zone offset in effect at the resolved wall time", () => {
    // 2026-10-24T23:30 local falls before the flip, so the +02:00 offset applies.
    expect(SchedulerAt.parse("2026-10-24T23:30:00", dstZone)).toBe(utc(2026, 10, 24, 21, 30))
    // Local 00:30 on 10-25 is still before the local flip instant (02:00),
    // so the +02:00 offset applies here too.
    expect(SchedulerAt.parse("2026-10-25T00:30:00", dstZone)).toBe(utc(2026, 10, 24, 22, 30))
    // Local 03:30 on 10-25 is after the flip, so the +03:00 offset applies.
    expect(SchedulerAt.parse("2026-10-25T03:30:00", dstZone)).toBe(utc(2026, 10, 25, 0, 30))
  })

  test("parses optional seconds, milliseconds, and offset spellings", () => {
    expect(SchedulerAt.parse("2026-11-02T09:00:30Z", offset(0))).toBe(utc(2026, 11, 2, 9, 0, 30))
    expect(SchedulerAt.parse("2026-11-02T09:00:30.250Z", offset(0))).toBe(utc(2026, 11, 2, 9, 0, 30, 250))
    expect(SchedulerAt.parse("2026-11-02T09:00+03:00", offset(0))).toBe(utc(2026, 11, 2, 6))
    expect(SchedulerAt.parse("2026-11-02 09:00:00+0300", offset(0))).toBe(utc(2026, 11, 2, 6))
  })

  test("rejects unparseable, truncated, and out-of-range values", () => {
    for (const value of [
      "",
      "not-a-date",
      "2026-11-02",
      "2026-11-02T09",
      "2026-11-02T",
      "2026-13-02T09:00:00Z",
      "2026-00-02T09:00:00Z",
      "2026-11-31T09:00:00Z",
      "2026-02-30T09:00:00Z",
      "2026-11-02T24:00:00Z",
      "2026-11-02T09:60:00Z",
      "2026-11-02T09:00:60Z",
      "2026-11-02T09:00:00+25:00",
      "2026-11-02T09:00:00+03:99",
      "2026-11-02T09:00:00+3",
      "2026-11-02T09:00:00Z ",
      " 2026-11-02T09:00:00Z",
    ]) {
      expect(SchedulerAt.parse(value, offset(0))).toBeUndefined()
    }
  })
})

describe("SchedulerAt.relativeParse", () => {
  test("parses the now+<integer><unit> form for every unit", () => {
    expect(SchedulerAt.relativeParse("now+90s")).toBe(90_000)
    expect(SchedulerAt.relativeParse("now+5m")).toBe(5 * 60_000)
    expect(SchedulerAt.relativeParse("now+2h")).toBe(2 * 3_600_000)
    expect(SchedulerAt.relativeParse("now+1d")).toBe(86_400_000)
    expect(SchedulerAt.relativeParse("now+120m")).toBe(120 * 60_000)
  })

  test("parses the now+HH:MM:SS form with hours first", () => {
    expect(SchedulerAt.relativeParse("now+01:30:25")).toBe(3_600_000 + 30 * 60_000 + 25_000)
    expect(SchedulerAt.relativeParse("now+00:00:01")).toBe(1_000)
    expect(SchedulerAt.relativeParse("now+25:00:00")).toBe(25 * 3_600_000)
    expect(SchedulerAt.relativeParse("now+99:59:59")).toBe(99 * 3_600_000 + 59 * 60_000 + 59_000)
  })

  test("rejects malformed relative values", () => {
    for (const value of [
      "",
      "now",
      "now+",
      "now+5",
      "now-5m",
      "now+ 5m",
      "now+5 m",
      "now+5x",
      "now+0m",
      "now+0s",
      "now+0h",
      "now+0d",
      "now++5m",
      "now+5mm",
      "now+1.5h",
      "NOW+5m",
      "now+1:2:3",
      "now+25:60:00",
      "now+00:60:00",
      "now+00:00:60",
      "now+01:30",
      "now+01:30:25:00",
      "now+0x:30:25",
      "now+1:30:25",
      "now+100:00:00",
      " now+5m",
      "now+5m ",
      "now+01:30:25 ",
    ]) {
      expect(SchedulerAt.relativeParse(value)).toBeUndefined()
    }
  })
})
