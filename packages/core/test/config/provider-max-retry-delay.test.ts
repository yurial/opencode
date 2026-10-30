import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigProviderV1 } from "@opencode-ai/core/v1/config/provider"

const decode = Schema.decodeUnknownSync(ConfigProviderV1.Info)

describe("ConfigProviderV1 maxRetryDelaySec option", () => {
  test("accepts positive integer seconds", () => {
    expect(decode({ options: { maxRetryDelaySec: 1 } }).options?.maxRetryDelaySec).toBe(1)
    expect(decode({ options: { maxRetryDelaySec: 600 } }).options?.maxRetryDelaySec).toBe(600)
  })

  test("leaves maxRetryDelaySec unset when not configured", () => {
    expect(decode({}).options?.maxRetryDelaySec).toBeUndefined()
    expect(decode({ options: { apiKey: "secret" } }).options?.maxRetryDelaySec).toBeUndefined()
  })

  test("rejects zero and negative maxRetryDelaySec", () => {
    expect(() => decode({ options: { maxRetryDelaySec: 0 } })).toThrow()
    expect(() => decode({ options: { maxRetryDelaySec: -5 } })).toThrow()
  })

  test("rejects non-integer maxRetryDelaySec", () => {
    expect(() => decode({ options: { maxRetryDelaySec: 2.5 } })).toThrow()
    expect(() => decode({ options: { maxRetryDelaySec: "300" } })).toThrow()
  })
})
