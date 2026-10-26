export * as SchedulerGate from "./gate"

import { ChildProcess } from "effect/unstable/process"
import { Context, Effect, Layer } from "effect"
import { AppProcess } from "../process"
import { makeGlobalNode } from "../effect/app-node"

/**
 * Capture bound for the combined output of a scheduler/gate-run, in bytes
 * (specs/scheduler.md R6.14). Memory safety only: the fired-message section
 * truncates the output far earlier (SCHEDULER_MAX_GATE_OUTPUT_LENGTH), so
 * this bound never changes a delivered section. Matches the V2 bash
 * capture limit.
 */
export const MAX_CAPTURE_BYTES = 1024 * 1024

/**
 * Exit status substituted when a scheduler/gate-run cannot be resolved —
 * a spawn failure (missing interpreter, unusable working directory) counts
 * as a nonzero exit status and suppresses its fire, with the output
 * discarded (specs/scheduler.md Error handling). 127 is the conventional
 * "command not found" status.
 */
export const SPAWN_FAILURE_EXIT_CODE = 127

/**
 * One resolved scheduler/gate-run (specs/scheduler.md Definitions):
 * `exitCode` is the exit status of the `bash -c` invocation — the exit
 * status of the run per the scheduler/gate-run definition — and `output`
 * the combined standard output and error of the run. A run that dies to a
 * signal surfaces as a nonzero exit code.
 */
export interface Result {
  readonly exitCode: number
  readonly output: string
}

/**
 * The process command runner of the scheduler service (specs/scheduler.md
 * I4, I8): executes one scheduler/gate-run.
 *
 * Contract:
 * - `command` is the stored scheduler/gate-command text; it runs as the
 *   single argument of the SCHEDULER_GATE_SHELL invocation `bash -c`
 *   (R6.17), whatever the host default shell is.
 * - `directory` is the working directory of the run — the location
 *   directory of the owning session (SCHEDULER_GATE_WORKING_DIRECTORY,
 *   R6.18). A directory that does not exist makes the run unresolvable.
 * - Never fails: an invocation that cannot be resolved (spawn failure)
 *   returns `SPAWN_FAILURE_EXIT_CODE` with empty output, so the exit
 *   status feeds the fire decision of R6.13 in every case (Error
 *   handling).
 * - A run may execute arbitrarily long — SCHEDULER_GATE_TIMEOUT is
 *   deliberately none (J9); the loop isolation of R8.6 with the
 *   single-flight hold of R8.7-R8.9 bounds what a long run delays.
 *
 * Undefined behavior: a command that outlives the process is abandoned
 * with its output (I10 — in-flight runs live in process memory only).
 */
export interface Interface {
  readonly run: (input: { readonly command: string; readonly directory: string }) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SchedulerGate") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    return Service.of({
      run: (input) =>
        appProcess
          .run(ChildProcess.make("bash", ["-c", input.command], { cwd: input.directory, stdin: "ignore" }), {
            combineOutput: true,
            maxOutputBytes: MAX_CAPTURE_BYTES,
          })
          .pipe(
            Effect.map((result) => ({ exitCode: result.exitCode, output: result.output?.toString("utf8") ?? "" })),
            // A run that fails to spawn — missing interpreter, unusable
            // working directory — counts as a nonzero exit status and
            // suppresses its fire (Error handling): total, never fails.
            Effect.catch(() => Effect.succeed({ exitCode: SPAWN_FAILURE_EXIT_CODE, output: "" })),
          ),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [AppProcess.node] })
