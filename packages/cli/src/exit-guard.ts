import * as Effect from "effect/Effect"
import type { Exit } from "effect/Exit"
import { defaultTeardown } from "effect/Runtime"
import type { Scope } from "effect/Scope"

// Backstop window for the teardown that runs after a command handler has
// completed: scoped finalizers only. The handler itself — including the TUI
// render and its epilogue — always finishes before the guard is armed, so the
// window never cuts live work short (a long-lived command like the TUI
// session or `serve` runs to its own exit before the window opens). The spec
// fixes no value for this constant (tui-architecture Configuration lists no
// exit-backstop level); 5 s matches the magnitude of the worker-shutdown
// timeout.
export const EXIT_BACKSTOP_TIMEOUT_MS = 5000

export type ExitGuard = {
  // Arm the backstop: from here on only teardown finalizers may run; if they
  // hang past the timeout the process force-exits instead of lingering.
  arm: () => void
  // Disarm a pending backstop and force the process to exit with the
  // accumulated process exit code.
  complete: () => void
}

export function exitGuard(input: {
  exit: (code: number) => void
  timeout?: number
  schedule?: (run: () => void, ms: number) => () => void
}): ExitGuard {
  const timeout = input.timeout ?? EXIT_BACKSTOP_TIMEOUT_MS
  const schedule = input.schedule ?? defaultSchedule
  let cancel: (() => void) | undefined
  const code = () => Number(process.exitCode ?? 0)
  return {
    arm: () => {
      cancel = schedule(() => input.exit(code()), timeout)
    },
    complete: () => {
      cancel?.()
      input.exit(code())
    },
  }
}

function defaultSchedule(run: () => void, ms: number) {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}

// Main-fiber teardown: run the default exit-code accounting, then always
// force the exit. The platform's own onExit only calls process.exit for
// nonzero codes or after SIGINT/SIGTERM; on success it leaves the process to
// drain the event loop, which leaked TTY file descriptors and worker threads
// keep alive forever.
export function mainTeardown<A, E>(exit: Exit<A, E>, onExit: (code: number) => void, complete: () => void) {
  defaultTeardown(exit, onExit)
  complete()
}

// Run a command program inside the guard's backstop window: the backstop arms
// when the program completes — success, failure, or interruption alike — so a
// finalizer hanging in the scope release that follows force-exits instead of
// lingering. Arming happens only after the program finished, so live work
// (a TUI session, `serve`) never falls inside the window.
export function guarded<A, E, R>(
  program: Effect.Effect<A, E, R>,
  guard: ExitGuard,
): Effect.Effect<A, E, Exclude<R, Scope>> {
  return Effect.scoped(Effect.onExit(program, () => Effect.sync(guard.arm)))
}
