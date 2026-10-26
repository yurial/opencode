import { expect, test } from "bun:test"
import { tmuxTabSequence } from "../src/util/tmux-tab"

test("wraps the sanitized title in the tmux window rename sequence", () => {
  expect(tmuxTabSequence("Fix login flow")).toBe("\x1bkFix login flow\x1b\\")
})

test("strips ANSI escapes and control characters", () => {
  expect(tmuxTabSequence("\x1b]0;evil\x07Fix\x1b[31m red")).toBe("\x1bkFix red\x1b\\")
  // ESC c is the RIS reset sequence: strip-ansi consumes ESC together with its
  // final byte, while bare C0/C1 controls are dropped individually.
  expect(tmuxTabSequence("a\u0007b\u001bc\u009bd")).toBe("\x1bkabd\x1b\\")
  expect(tmuxTabSequence("a\u0000b\u0007c\u009Fd")).toBe("\x1bkabcd\x1b\\")
})

test("collapses newlines and trims whitespace", () => {
  expect(tmuxTabSequence("  first\n\nsecond  ")).toBe("\x1bkfirst second\x1b\\")
  expect(tmuxTabSequence("\r\n\t spaced \t")).toBe("\x1bkspaced\x1b\\")
})

test("truncates to 60 code points without splitting surrogate pairs", () => {
  expect(tmuxTabSequence("x".repeat(100))).toBe(`\x1bk${"x".repeat(60)}\x1b\\`)
  const result = tmuxTabSequence("a".repeat(59) + "🚀🚀🚀")
  expect(result).toBeDefined()
  const name = Array.from(result!.slice(2, -2))
  expect(name).toHaveLength(60)
  expect(name[59]).toBe("🚀")
  expect(result!.startsWith("\x1bk")).toBe(true)
  expect(result!.endsWith("\x1b\\")).toBe(true)
})

test("skips emission for empty or garbage titles", () => {
  expect(tmuxTabSequence(undefined)).toBeUndefined()
  expect(tmuxTabSequence("")).toBeUndefined()
  expect(tmuxTabSequence("   ")).toBeUndefined()
  expect(tmuxTabSequence("\x1b[31m\u0007\u001b[0m")).toBeUndefined()
  expect(tmuxTabSequence("　")).toBeUndefined()
})
