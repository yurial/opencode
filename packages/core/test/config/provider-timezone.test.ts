import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigProviderV1 } from "@opencode-ai/core/v1/config/provider"

const decode = Schema.decodeUnknownSync(ConfigProviderV1.Info)

describe("ConfigProviderV1 timezone option", () => {
  test("accepts IANA zone names", () => {
    expect(decode({ options: { timezone: "Asia/Novosibirsk" } }).options?.timezone).toBe("Asia/Novosibirsk")
    expect(decode({ options: { timezone: "Europe/Moscow" } }).options?.timezone).toBe("Europe/Moscow")
    expect(decode({ options: { timezone: "UTC" } }).options?.timezone).toBe("UTC")
  })

  test("accepts explicit offsets", () => {
    expect(decode({ options: { timezone: "+05:00" } }).options?.timezone).toBe("+05:00")
    expect(decode({ options: { timezone: "-0830" } }).options?.timezone).toBe("-0830")
    expect(decode({ options: { timezone: "+03" } }).options?.timezone).toBe("+03")
  })

  test("leaves timezone unset when not configured", () => {
    expect(decode({}).options?.timezone).toBeUndefined()
    expect(decode({ options: { apiKey: "secret" } }).options?.timezone).toBeUndefined()
  })

  test("rejects malformed timezone values at config load", () => {
    for (const value of ["Not/AZone", "UTC+3", "05:00", "+5:00", "+05:60", "+059", "", "Novosibirsk"]) {
      expect(() => decode({ options: { timezone: value } })).toThrow()
    }
  })
})
