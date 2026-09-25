import { describe, expect, test } from "bun:test"
import {
  createDialogSessionListQuery,
  loadDialogSessionList,
  resolveSessionSwitch,
} from "../../src/component/dialog-session-list"

describe("dialog session list", () => {
  test("requests root sessions for the default browse list", () => {
    expect(createDialogSessionListQuery({ filter: { path: "packages/tui" } })).toEqual({
      roots: true,
      limit: 100,
      path: "packages/tui",
    })
  })

  test("requests root sessions for search results", () => {
    expect(createDialogSessionListQuery({ search: " deploy ", filter: { scope: "project" } })).toEqual({
      roots: true,
      limit: 30,
      search: "deploy",
      scope: "project",
    })
  })

  test("keeps the cache usable while the root request is pending", async () => {
    let resolve!: (result: { data: string[] }) => void
    const pending = loadDialogSessionList<string>({
      filter: {},
      list: () => new Promise((done) => (resolve = done)),
    })

    expect(await Promise.race([pending, Promise.resolve("pending")])).toBe("pending")
    resolve({ data: ["root"] })
    expect(await pending).toEqual(["root"])
  })

  test("falls back when the root request returns an error response", async () => {
    expect(await loadDialogSessionList({ filter: {}, list: async () => ({}) })).toBeUndefined()
  })

  test("falls back when the root request rejects", async () => {
    expect(
      await loadDialogSessionList({
        filter: {},
        list: () => Promise.reject(new Error("offline")),
      }),
    ).toBeUndefined()
  })
})

describe("resolveSessionSwitch", () => {
  test("deletes the current session before switching when opened by /delete", () => {
    expect(resolveSessionSwitch({ deleteCurrent: true, current: "ses_a", selected: "ses_b" })).toEqual({
      action: "delete-then-navigate",
      sessionID: "ses_a",
      navigateTo: "ses_b",
    })
  })

  test("treats picking the current session as cancelling the deletion", () => {
    expect(resolveSessionSwitch({ deleteCurrent: true, current: "ses_a", selected: "ses_a" })).toEqual({
      action: "none",
    })
  })

  test("cancels when there is no current session to delete", () => {
    expect(resolveSessionSwitch({ deleteCurrent: true, selected: "ses_b" })).toEqual({
      action: "navigate",
      navigateTo: "ses_b",
    })
  })

  test("navigates without deleting when the dialog is opened by /sessions", () => {
    expect(resolveSessionSwitch({ current: "ses_a", selected: "ses_b" })).toEqual({
      action: "navigate",
      navigateTo: "ses_b",
    })
    expect(resolveSessionSwitch({ deleteCurrent: false, current: "ses_a", selected: "ses_b" })).toEqual({
      action: "navigate",
      navigateTo: "ses_b",
    })
  })
})
