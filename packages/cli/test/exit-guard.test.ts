import { describe, expect, test } from "bun:test"
import { fail, succeed } from "effect/Exit"
import { EXIT_BACKSTOP_TIMEOUT_MS, exitGuard, mainTeardown } from "../src/exit-guard"

// Bun cannot delete or reset process.exitCode to undefined inside one
// process, so every test assigns the code it asserts on explicitly. The
// zero-code case must run first: only a fresh process still has
// process.exitCode unset.
function harness(code: number) {
  process.exitCode = code
  const exits: number[] = []
  const cancelled: number[] = []
  let scheduled: (() => void) | undefined
  let timeout = 0
  return {
    exits,
    cancelled,
    run: () => scheduled?.(),
    guard: exitGuard({
      exit: (exitCode) => exits.push(exitCode),
      schedule: (run, ms) => {
        scheduled = run
        timeout = ms
        return () => {
          cancelled.push(1)
          scheduled = undefined
        }
      },
    }),
    timeout: () => timeout,
  }
}

describe("exitGuard", () => {
  test("complete exits with code 0 when no exit code was ever set", () => {
    const exits: number[] = []
    const guard = exitGuard({ exit: (code) => exits.push(code), schedule: () => () => {} })
    guard.complete()
    expect(exits).toEqual([0])
    process.exitCode = 0
  })

  test("backstop force-exits with the accumulated process exit code", () => {
    const state = harness(1)
    try {
      state.guard.arm()
      expect(state.timeout()).toBe(EXIT_BACKSTOP_TIMEOUT_MS)
      state.run()
      expect(state.exits).toEqual([1])
    } finally {
      process.exitCode = 0
    }
  })

  test("complete cancels a pending backstop and exits with the accumulated code", () => {
    const state = harness(3)
    try {
      state.guard.arm()
      state.guard.complete()
      expect(state.cancelled).toEqual([1])
      expect(state.exits).toEqual([3])
      state.run()
      expect(state.exits).toEqual([3])
    } finally {
      process.exitCode = 0
    }
  })

  test("without an injected schedule it uses a cancellable timer", () => {
    process.exitCode = 7
    try {
      const exits: number[] = []
      const guard = exitGuard({ exit: (code) => exits.push(code), timeout: 3600_000 })
      guard.arm()
      guard.complete()
      expect(exits).toEqual([7])
    } finally {
      process.exitCode = 0
    }
  })
})

describe("mainTeardown", () => {
  test("success forces the exit after the default accounting", () => {
    const codes: number[] = []
    let completed = 0
    mainTeardown(succeed("done"), (code) => codes.push(code), () => completed++)
    expect(codes).toEqual([0])
    expect(completed).toBe(1)
  })

  test("failure reports a nonzero code through onExit", () => {
    const codes: number[] = []
    let completed = 0
    mainTeardown(fail(new Error("boom")), (code) => codes.push(code), () => completed++)
    expect(codes).toEqual([1])
    expect(completed).toBe(1)
  })
})
