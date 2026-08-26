import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigProviderV1 } from "@opencode-ai/core/v1/config/provider"

const decode = Schema.decodeUnknownSync(ConfigProviderV1.Info)

describe("ConfigProviderV1 retries option", () => {
  test("accepts retries within 0-1000000", () => {
    expect(decode({ options: { retries: 0 } }).options?.retries).toBe(0)
    expect(decode({ options: { retries: 1000000 } }).options?.retries).toBe(1000000)
  })

  test("leaves retries unset when not configured", () => {
    expect(decode({}).options?.retries).toBeUndefined()
    expect(decode({ options: { apiKey: "secret" } }).options?.retries).toBeUndefined()
  })

  test("rejects retries outside 0-1000000", () => {
    expect(() => decode({ options: { retries: 1000001 } })).toThrow()
    expect(() => decode({ options: { retries: -1 } })).toThrow()
  })

  test("rejects non-integer retries", () => {
    expect(() => decode({ options: { retries: 2.5 } })).toThrow()
    expect(() => decode({ options: { retries: "3" } })).toThrow()
  })
})
