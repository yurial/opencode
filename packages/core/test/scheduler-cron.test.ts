import { describe, expect, test } from "bun:test"
import { SchedulerCron } from "@opencode-ai/core/scheduler/cron"

const utc = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millis = 0,
) => Date.UTC(year, month - 1, day, hour, minute, second, millis)

describe("SchedulerCron.parse", () => {
  test("parses five fields into sorted value sets", () => {
    const parsed = SchedulerCron.parse("*/30 */6 1,15 1-3 1")
    expect(parsed).toBeDefined()
    expect(parsed!.minute).toEqual([0, 30])
    expect(parsed!.hour).toEqual([0, 6, 12, 18])
    expect(parsed!.dayOfMonth).toEqual([1, 15])
    expect(parsed!.month).toEqual([1, 2, 3])
    expect(parsed!.dayOfWeek).toEqual([1])
  })

  test("marks restricted day fields", () => {
    const unrestricted = SchedulerCron.parse("0 0 * * *")
    expect(unrestricted!.dayOfMonthRestricted).toBe(false)
    expect(unrestricted!.dayOfWeekRestricted).toBe(false)
    const domOnly = SchedulerCron.parse("0 0 1 * *")
    expect(domOnly!.dayOfMonthRestricted).toBe(true)
    expect(domOnly!.dayOfWeekRestricted).toBe(false)
    const dowOnly = SchedulerCron.parse("0 0 * * 1")
    expect(dowOnly!.dayOfMonthRestricted).toBe(false)
    expect(dowOnly!.dayOfWeekRestricted).toBe(true)
  })

  test("normalizes day-of-week 7 to Sunday", () => {
    expect(SchedulerCron.parse("0 0 * * 7")!.dayOfWeek).toEqual([0])
    expect(SchedulerCron.parse("0 0 * * 0")!.dayOfWeek).toEqual([0])
  })

  test("rejects malformed expressions", () => {
    for (const expression of [
      "",
      "* * * *",
      "* * * * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * 32 * *",
      "* * * 0 *",
      "* * * 13 *",
      "* * * * 8",
      "a * * * *",
      "*/0 * * * *",
      "*/-5 * * * *",
      "5-1 * * * *",
      "1-5/ * * * *",
      "0 0 * JAN *",
      "0 0 * * MON",
      "-5 * * * *",
    ]) {
      expect(SchedulerCron.parse(expression)).toBeUndefined()
    }
  })
})

describe("SchedulerCron.matches", () => {
  test("matches the minute the instant falls into", () => {
    const expression = SchedulerCron.parse("*/45 * * * *")!
    expect(SchedulerCron.matches(expression, utc(2026, 10, 24, 13, 0, 0))).toBe(true)
    expect(SchedulerCron.matches(expression, utc(2026, 10, 24, 13, 45, 0))).toBe(true)
    expect(SchedulerCron.matches(expression, utc(2026, 10, 24, 13, 30, 0))).toBe(false)
    // Sub-minute parts are ignored: the instant matches the minute it falls into.
    expect(SchedulerCron.matches(expression, utc(2026, 10, 24, 13, 45, 30, 250))).toBe(true)
  })

  test("follows standard cron restart for steps across field boundaries", () => {
    const expression = SchedulerCron.parse("*/45 * * * *")!
    expect(SchedulerCron.matches(expression, utc(2026, 10, 24, 14, 0, 0))).toBe(true)
    expect(SchedulerCron.matches(expression, utc(2026, 10, 24, 14, 45, 0))).toBe(true)
  })

  test("applies the vixie day rule when both day fields are restricted", () => {
    const expression = SchedulerCron.parse("0 0 1 * 1")!
    // 2026-10-26 is a Monday (day-of-week matches, day 26 does not).
    expect(SchedulerCron.matches(expression, utc(2026, 10, 26, 0, 0))).toBe(true)
    // 2026-11-01 is day-of-month 1 (a Sunday — the day-of-week field alone would reject it).
    expect(SchedulerCron.matches(expression, utc(2026, 11, 1, 0, 0))).toBe(true)
    // 2026-10-27 is a Tuesday that is not day 1: neither field matches.
    expect(SchedulerCron.matches(expression, utc(2026, 10, 27, 0, 0))).toBe(false)
  })

  test("evaluates on the UTC clock", () => {
    const expression = SchedulerCron.parse("0 13 * * *")!
    expect(SchedulerCron.matches(expression, utc(2026, 10, 24, 13, 0))).toBe(true)
    expect(SchedulerCron.matches(expression, utc(2026, 10, 24, 16, 0))).toBe(false)
  })
})

describe("SchedulerCron.next", () => {
  test("returns the earliest match strictly after the instant", () => {
    const expression = SchedulerCron.parse("*/30 * * * *")!
    expect(SchedulerCron.next(expression, utc(2026, 10, 24, 13, 0))).toBe(utc(2026, 10, 24, 13, 30))
    expect(SchedulerCron.next(expression, utc(2026, 10, 24, 13, 15))).toBe(utc(2026, 10, 24, 13, 30))
    expect(SchedulerCron.next(expression, utc(2026, 10, 24, 13, 30))).toBe(utc(2026, 10, 24, 14, 0))
  })

  test("excludes a match equal to the instant, including sub-minute instants", () => {
    const expression = SchedulerCron.parse("0 * * * *")!
    expect(SchedulerCron.next(expression, utc(2026, 10, 24, 13, 0))).toBe(utc(2026, 10, 24, 14, 0))
    expect(SchedulerCron.next(expression, utc(2026, 10, 24, 13, 0, 0, 500))).toBe(utc(2026, 10, 24, 14, 0))
  })

  test("rolls over days, months, and years", () => {
    expect(SchedulerCron.next(SchedulerCron.parse("0 0 * * *")!, utc(2026, 10, 24, 13, 0))).toBe(
      utc(2026, 10, 25, 0, 0),
    )
    expect(SchedulerCron.next(SchedulerCron.parse("0 0 1 * *")!, utc(2026, 1, 31, 12, 0))).toBe(utc(2026, 2, 1, 0, 0))
    expect(SchedulerCron.next(SchedulerCron.parse("0 0 1 1 *")!, utc(2026, 6, 1, 0, 0))).toBe(utc(2027, 1, 1, 0, 0))
  })

  test("advances from a catch-up delivery time to the next hour match", () => {
    // Spec E7: a 0 * * * * schedule delivered at 15:37 next fires at 16:00.
    expect(SchedulerCron.next(SchedulerCron.parse("0 * * * *")!, utc(2026, 10, 24, 15, 37))).toBe(
      utc(2026, 10, 24, 16, 0),
    )
  })

  test("reports no future match for impossible day combinations", () => {
    expect(SchedulerCron.next(SchedulerCron.parse("0 0 30 2 *")!, utc(2026, 1, 1, 0, 0))).toBeUndefined()
  })

  test("finds leap-day matches within the scan horizon", () => {
    expect(SchedulerCron.next(SchedulerCron.parse("0 0 29 2 *")!, utc(2025, 1, 1, 0, 0))).toBe(utc(2028, 2, 29, 0, 0))
  })

  test("finds the next weekday match", () => {
    // 2026-10-24 is a Saturday; the next Monday is 2026-10-26.
    expect(SchedulerCron.next(SchedulerCron.parse("0 0 * * 1")!, utc(2026, 10, 24, 12, 0))).toBe(
      utc(2026, 10, 26, 0, 0),
    )
  })
})

describe("SchedulerCron.fromEvery", () => {
  test("converts every unit per spec I1", () => {
    expect(SchedulerCron.fromEvery("30m")).toBe("*/30 * * * *")
    expect(SchedulerCron.fromEvery("45m")).toBe("*/45 * * * *")
    expect(SchedulerCron.fromEvery("1h")).toBe("0 */1 * * *")
    expect(SchedulerCron.fromEvery("6h")).toBe("0 */6 * * *")
    expect(SchedulerCron.fromEvery("1d")).toBe("0 0 */1 * *")
    expect(SchedulerCron.fromEvery("7d")).toBe("0 0 */7 * *")
  })

  test("rejects malformed intervals", () => {
    for (const value of ["", "m", "0m", "-5m", "30", "30x", "30mi", "1.5h", "1h30m", " 30m", "30m ", "30M", "1D"]) {
      expect(SchedulerCron.fromEvery(value)).toBeUndefined()
    }
  })
})
