import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { hasInterruptsOnly } from "effect/Cause"
import { fail, isFailure, succeed } from "effect/Exit"
import { EXIT_BACKSTOP_TIMEOUT_MS, exitGuard, guarded, mainTeardown } from "../src/exit-guard"

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

// Guards the backstop-window tests: the injected schedule records the arming
// among the window events and keeps the scheduled run callable on demand.
function windowHarness() {
  const events: string[] = []
  let scheduled: (() => void) | undefined
  return {
    events,
    fire: () => scheduled?.(),
    guard: exitGuard({
      exit: (code) => events.push(`exit:${code}`),
      schedule: (run) => {
        events.push("arm")
        scheduled = run
        return () => events.push("cancel")
      },
    }),
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

describe("guarded", () => {
  test("failure exit arms the backstop over the finalizer window and keeps exit code 1", () => {
    process.exitCode = 1
    try {
      const state = windowHarness()
      const outcome = Effect.runSyncExit(
        guarded(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => state.events.push("acquire")),
              () => Effect.sync(() => state.events.push("finalizer")),
            )
            return yield* Effect.fail(new Error("boom"))
          }),
          state.guard,
        ),
      )
      expect(isFailure(outcome)).toBe(true)
      expect(state.events).toEqual(["acquire", "arm", "finalizer"])
      state.fire()
      expect(state.events).toEqual(["acquire", "arm", "finalizer", "exit:1"])
    } finally {
      process.exitCode = 0
    }
  })

  test("interruption exit arms the backstop over the finalizer window and keeps the accumulated exit code", () => {
    process.exitCode = 1
    try {
      const state = windowHarness()
      const outcome = Effect.runSyncExit(
        guarded(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => state.events.push("acquire")),
              () => Effect.sync(() => state.events.push("finalizer")),
            )
            return yield* Effect.interrupt
          }),
          state.guard,
        ),
      )
      expect(isFailure(outcome) && hasInterruptsOnly(outcome.cause)).toBe(true)
      expect(state.events).toEqual(["acquire", "arm", "finalizer"])
      state.fire()
      expect(state.events).toEqual(["acquire", "arm", "finalizer", "exit:1"])
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
