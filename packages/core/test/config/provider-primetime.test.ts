import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigProviderV1 } from "@opencode-ai/core/v1/config/provider"

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
