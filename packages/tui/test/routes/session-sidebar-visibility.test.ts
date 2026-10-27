// The session sidebar visibility rule (specs/tui-architecture.md R20): the
// sidebar renders for root and child (subagent) sessions alike — the manual
// toggle shows it, otherwise auto mode shows it on terminals wider than the
// inline width. The viewed session's parentID must not hide it; the rule is
// the exact function the session route memo evaluates.
import { describe, expect, test } from "bun:test"
import { sidebarVisibleRule } from "../../src/routes/session"

describe("session sidebar visibility", () => {
  test("a subagent session gets the sidebar under the shared auto rule", () => {
    expect(sidebarVisibleRule({ parentID: "ses_root", open: false, mode: "auto", wide: true })).toBe(true)
  })

  test("a root session keeps the auto + wide rule", () => {
    expect(sidebarVisibleRule({ open: false, mode: "auto", wide: true })).toBe(true)
  })

  test("the manual toggle wins over hide mode, for root and subagent alike", () => {
    expect(sidebarVisibleRule({ open: true, mode: "hide", wide: false })).toBe(true)
    expect(sidebarVisibleRule({ parentID: "ses_root", open: true, mode: "hide", wide: false })).toBe(true)
  })

  test("hide mode and a narrow terminal keep the sidebar hidden", () => {
    expect(sidebarVisibleRule({ open: false, mode: "hide", wide: true })).toBe(false)
    expect(sidebarVisibleRule({ open: false, mode: "auto", wide: false })).toBe(false)
    expect(sidebarVisibleRule({ parentID: "ses_root", open: false, mode: "auto", wide: false })).toBe(false)
  })
})
