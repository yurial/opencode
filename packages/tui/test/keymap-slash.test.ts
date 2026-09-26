import { describe, expect, test } from "bun:test"
import { parseSlashCommand, slashCommandArg, slashCommandToken } from "../src/keymap"

describe("parseSlashCommand", () => {
  test("parses a bare slash command without arguments", () => {
    expect(parseSlashCommand("/delete")).toEqual({ name: "delete", args: "" })
  })

  test("parses a slash command with a single argument", () => {
    expect(parseSlashCommand("/delete ses_123")).toEqual({ name: "delete", args: "ses_123" })
  })

  test("keeps extra arguments and following lines in args", () => {
    expect(parseSlashCommand("/delete ses_1 extra\nsecond line")).toEqual({
      name: "delete",
      args: "ses_1 extra second line",
    })
  })

  test("returns undefined for text without a leading slash command", () => {
    expect(parseSlashCommand("delete ses_1")).toBeUndefined()
    expect(parseSlashCommand("/")).toBeUndefined()
    expect(parseSlashCommand("/ delete")).toBeUndefined()
  })
})

describe("slashCommandArg", () => {
  test("returns the trimmed argument from the command payload", () => {
    expect(slashCommandArg({ payload: " ses_123 " })).toBe("ses_123")
  })

  test("returns undefined for blank or non-string payloads", () => {
    expect(slashCommandArg({ payload: "   " })).toBeUndefined()
    expect(slashCommandArg({ payload: 42 })).toBeUndefined()
    expect(slashCommandArg({})).toBeUndefined()
    expect(slashCommandArg(undefined)).toBeUndefined()
  })
})

describe("slashCommandToken", () => {
  test("takes only the first whitespace-separated token", () => {
    expect(slashCommandToken({ payload: "ses_123 extra words" })).toBe("ses_123")
    expect(slashCommandToken({ payload: "  ses_1\tsecond  " })).toBe("ses_1")
  })

  test("passes a single-token argument through", () => {
    expect(slashCommandToken({ payload: "ses_123" })).toBe("ses_123")
  })

  test("returns undefined for blank or non-string payloads", () => {
    expect(slashCommandToken({ payload: "   " })).toBeUndefined()
    expect(slashCommandToken(undefined)).toBeUndefined()
  })
})
