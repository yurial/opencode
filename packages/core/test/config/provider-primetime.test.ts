import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  ConfigProviderV1,
  isPrimeTimeEnforced,
  primeTimeActive,
  primeTimeWindowEnd,
  setPrimeTimeEnforced,
} from "@opencode-ai/core/v1/config/provider"

const decode = Schema.decodeUnknownSync(ConfigProviderV1.Model)
const decodeInfo = Schema.decodeUnknownSync(ConfigProviderV1.Info)

describe("ConfigProviderV1 prime-time model schema", () => {
  test("accepts valid bound formats with and without zone suffixes", () => {
    for (const start of [
      "09:00",
      "09:00:00",
      "23:59:59",
      "00:00",
      "09:00Z",
      "09:00:00Z",
      "09:00+05:30",
      "09:00+0530",
      "09:00+05",
      "23:59:59-09:30",
      "23:59-0930",
      "00:00+14",
    ]) {
      expect(decode({ primeTimeStart: start }).primeTimeStart).toBe(start)
    }
  })

  test("rejects malformed bounds as config load errors", () => {
    for (const start of [
      "9am",
      "",
      "25:00:00",
      "09:60:00",
      "09:00:60",
      "9:00",
      "09:0",
      "0900",
      "09:00:00+9:30",
      "09:00:00Z+01:00",
      "09:00:00+05:99",
      "09:00:00+059",
      "09:00:00+5",
    ]) {
      expect(() => decode({ primeTimeStart: start })).toThrow()
    }
    expect(() => decode({ primeTimeEnd: "garbage" })).toThrow()
  })

  test("accepts consistent start and end zone pairs", () => {
    expect(decode({ primeTimeStart: "09:00", primeTimeEnd: "18:00" }).primeTimeEnd).toBe("18:00")
    expect(decode({ primeTimeStart: "09:00Z", primeTimeEnd: "18:00Z" }).primeTimeEnd).toBe("18:00Z")
    expect(decode({ primeTimeStart: "09:00+03", primeTimeEnd: "18:00+03:00" }).primeTimeEnd).toBe("18:00+03:00")
    expect(decode({ primeTimeStart: "09:00+0300", primeTimeEnd: "18:00+03" }).primeTimeEnd).toBe("18:00+03")
    expect(decode({ primeTimeStart: "09:00Z", primeTimeEnd: "18:00+00:00" }).primeTimeEnd).toBe("18:00+00:00")
    expect(decode({ primeTimeStart: "09:00-05:00", primeTimeEnd: "18:00-0500" }).primeTimeEnd).toBe("18:00-0500")
  })

  test("rejects a zone suffix on only one bound", () => {
    expect(() => decode({ primeTimeStart: "09:00", primeTimeEnd: "18:00:00Z" })).toThrow()
    expect(() => decode({ primeTimeStart: "09:00:00Z", primeTimeEnd: "18:00" })).toThrow()
    expect(() => decode({ primeTimeStart: "09:00+03:00", primeTimeEnd: "18:00" })).toThrow()
  })

  test("rejects differing offsets on the two bounds", () => {
    expect(() => decode({ primeTimeStart: "09:00+03:00", primeTimeEnd: "18:00+05:00" })).toThrow()
    expect(() => decode({ primeTimeStart: "09:00Z", primeTimeEnd: "18:00+01:00" })).toThrow()
    expect(() => decode({ primeTimeStart: "09:00-05", primeTimeEnd: "18:00+05" })).toThrow()
  })

  test("allows a single bound without its pair", () => {
    expect(decode({ primeTimeStart: "09:00Z" }).primeTimeStart).toBe("09:00Z")
    expect(decode({ primeTimeEnd: "18:00" }).primeTimeEnd).toBe("18:00")
  })

  test("accepts a boolean primeTimeRetry flag and defaults to absent", () => {
    expect(decode({ primeTimeRetry: true }).primeTimeRetry).toBe(true)
    expect(decode({ primeTimeRetry: false }).primeTimeRetry).toBe(false)
    expect(decode({}).primeTimeRetry).toBeUndefined()
    expect(() => decode({ primeTimeRetry: "yes" })).toThrow()
    expect(decodeInfo({ models: { m1: { primeTimeRetry: true } } }).models?.m1?.primeTimeRetry).toBe(true)
  })

  test("enforces the same rules through the provider Info schema", () => {
    expect(() => decodeInfo({ models: { m1: { primeTimeStart: "09:00", primeTimeEnd: "18:00Z" } } })).toThrow()
    expect(() =>
      decodeInfo({ models: { m1: { primeTimeStart: "09:00+03:00", primeTimeEnd: "18:00+05:00" } } }),
    ).toThrow()
    expect(() => decodeInfo({ models: { m1: { primeTimeStart: "9am" } } })).toThrow()
    expect(
      decodeInfo({ models: { m1: { primeTimeStart: "09:00Z", primeTimeEnd: "18:00Z" } } }).models?.m1?.primeTimeStart,
    ).toBe("09:00Z")
  })
})

describe("ConfigProviderV1 prime-time enforcement toggle", () => {
  // 2026-08-24 is a Monday; Z-suffixed bounds keep every case independent of
  // the process timezone.
  const now = new Date(Date.UTC(2026, 7, 24, 12))
  const primeWindow = { primeTimeStart: "00:00:00Z", primeTimeEnd: "23:59:59Z", primeTimeDay: ["mon"] }
  // The listed Monday span covers the whole UTC day, so the window ends at the
  // next midnight.
  const windowEnd = Date.UTC(2026, 7, 25)

  beforeEach(() => {
    setPrimeTimeEnforced(true)
  })

  // The toggle is module-level process state; restore the default after every
  // test so the file cannot leak a disabled toggle into other test files.
  afterEach(() => {
    setPrimeTimeEnforced(true)
  })

  test("reports no active window when enforcement is disabled", () => {
    expect(primeTimeActive(primeWindow, now)).toBe(true)
    setPrimeTimeEnforced(false)
    expect(isPrimeTimeEnforced()).toBe(false)
    expect(primeTimeActive(primeWindow, now)).toBe(false)
  })

  test("re-enabling restores enforcement", () => {
    setPrimeTimeEnforced(false)
    expect(primeTimeActive(primeWindow, now)).toBe(false)
    setPrimeTimeEnforced(true)
    expect(isPrimeTimeEnforced()).toBe(true)
    expect(primeTimeActive(primeWindow, now)).toBe(true)
  })

  test("primeTimeWindowEnd reports no end while enforcement is disabled", () => {
    expect(primeTimeWindowEnd(primeWindow, now)).toBe(windowEnd)
    setPrimeTimeEnforced(false)
    expect(primeTimeWindowEnd(primeWindow, now)).toBeUndefined()
    expect(primeTimeActive(primeWindow, now)).toBe(false)
  })
})

describe("ConfigProviderV1 prime-time window timezone", () => {
  // 2026-08-24 is a Monday. Suffix-less bounds pick up the window's
  // `timezone`; every instant below is expressed in UTC to stay independent of
  // the process timezone.
  beforeEach(() => {
    setPrimeTimeEnforced(true)
  })

  afterEach(() => {
    setPrimeTimeEnforced(true)
  })

  test("interprets suffix-less bounds in a fixed-offset provider timezone", () => {
    const window = { primeTimeStart: "22:00:00", primeTimeEnd: "23:00:00", primeTimeDay: ["mon"], timezone: "+05:00" }
    // 22:30 in +05:00 is 17:30Z on the listed Monday.
    const now = new Date(Date.UTC(2026, 7, 24, 17, 30))
    expect(primeTimeActive(window, now)).toBe(true)
    // The span ends one second past the 23:00:00 wall-clock bound in +05:00.
    expect(primeTimeWindowEnd(window, now)).toBe(Date.UTC(2026, 7, 24, 18, 0, 1))
  })

  test("interprets suffix-less bounds in an IANA provider timezone", () => {
    const window = {
      primeTimeStart: "22:00:00",
      primeTimeEnd: "23:00:00",
      primeTimeDay: ["mon"],
      timezone: "Asia/Novosibirsk",
    }
    // 22:30 in Asia/Novosibirsk (+07:00) is 15:30Z on the listed Monday.
    const now = new Date(Date.UTC(2026, 7, 24, 15, 30))
    expect(primeTimeActive(window, now)).toBe(true)
    expect(primeTimeWindowEnd(window, now)).toBe(Date.UTC(2026, 7, 24, 16, 0, 1))
  })

  test("derives the window-timezone weekday of now from the provider timezone", () => {
    const window = { primeTimeStart: "22:00:00", primeTimeEnd: "23:00:00", primeTimeDay: ["mon"], timezone: "+05:00" }
    // 23:50Z on Monday is 04:50+05:00 Tuesday, so the listed Monday misses.
    expect(primeTimeActive(window, new Date(Date.UTC(2026, 7, 24, 23, 50)))).toBe(false)
  })

  test("explicit bound suffixes keep precedence over the provider timezone", () => {
    const window = { primeTimeStart: "22:00:00Z", primeTimeEnd: "23:00:00Z", primeTimeDay: ["mon"], timezone: "+05:00" }
    // 22:30Z is 03:30+05:00 Tuesday: the provider timezone must be ignored.
    const now = new Date(Date.UTC(2026, 7, 24, 22, 30))
    expect(primeTimeActive(window, now)).toBe(true)
    expect(primeTimeWindowEnd(window, now)).toBe(Date.UTC(2026, 7, 24, 23, 0, 1))
  })
})
