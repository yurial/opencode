export * as InteractiveJobs from "./store"

import { Schema } from "effect"
import { Context, Effect, Layer } from "effect"
import type { SessionSchema } from "../../session/schema"
import { makeLocationNode } from "../../effect/app-node"
import type { CancelReason, Result } from "./job"
import type { InteractiveGovernor } from "./governor"

// ---------------------------------------------------------------------------
// Model-facing errors
// ---------------------------------------------------------------------------

/**
 * Unknown job (spec R12): the jobID was never started in this runtime, the
 * runtime restarted since (jobs do not survive restarts), or the jobID is
 * owned by another Session (job IDs are Session-scoped, spec R2).
 */
export class UnknownJobError extends Schema.TaggedErrorClass<UnknownJobError>()(
  "InteractiveJobs.UnknownJobError",
  { jobID: Schema.String },
) {
  override get message() {
    return `Unknown interactive job: ${this.jobID}. Jobs do not survive runtime restarts.`
  }
}

/**
 * Write against a terminal job (spec R12/I3): terminal jobs accept no stdin.
 * Names the terminal status and the spool `outputPath` so the model can page
 * the remaining output with `read`. `wait`/`cancel` on terminal jobs are
 * idempotent successes instead (spec R13/R14).
 */
export class TerminalJobError extends Schema.TaggedErrorClass<TerminalJobError>()(
  "InteractiveJobs.TerminalJobError",
  { jobID: Schema.String, status: Schema.String, outputPath: Schema.String },
) {
  override get message() {
    return `Interactive job ${this.jobID} is already terminal (status: ${this.status}); full output: ${this.outputPath}`
  }
}

/**
 * A second call while another call is in flight for the same job fails fast,
 * naming the in-flight call (spec R19). Calls against one job serialize in
 * the job store.
 */
export class BusyJobError extends Schema.TaggedErrorClass<BusyJobError>()("InteractiveJobs.BusyJobError", {
  jobID: Schema.String,
  call: Schema.String,
}) {
  override get message() {
    return `Interactive job ${this.jobID} has a call in flight (${this.call}); wait for it to settle`
  }
}

/** `interactive_write` with `input: ""` and no `eof: true` (spec R12). */
export class EmptyWriteError extends Schema.TaggedErrorClass<EmptyWriteError>()(
  "InteractiveJobs.EmptyWriteError",
  { jobID: Schema.String },
) {
  override get message() {
    return `Empty interactive_write to ${this.jobID}: include the text to send (with its trailing newline) or set eof: true`
  }
}

/** Everything `start`/`write`/`wait`/`cancel` can fail with, all model-facing. */
export type StoreError =
  | UnknownJobError
  | TerminalJobError
  | BusyJobError
  | EmptyWriteError
  | InteractiveGovernor.TooManyJobsError

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface StartRequest {
  readonly sessionID: SessionSchema.ID
  /** Shell command string, executed like bash's (spec R7). */
  readonly command: string
  /** Defaults to the active Location; relative resolves from it (spec R7). */
  readonly workdir?: string
  /** Job lifetime in ms; default/clamped by the governor (spec R7/R20). */
  readonly timeout?: number
}

export interface WriteRequest {
  readonly sessionID: SessionSchema.ID
  readonly jobID: string
  /** Exact bytes appended to the child's stdin; include "\n" yourself (spec R11). */
  readonly input: string
  /** Signal end-of-input after writing (^D on the PTY) (spec R11). */
  readonly eof?: boolean
}

export interface WaitRequest {
  readonly sessionID: SessionSchema.ID
  readonly jobID: string
  /** Deadline in ms; default/clamped by the governor (spec R13). */
  readonly timeout?: number
}

export interface CancelRequest {
  readonly sessionID: SessionSchema.ID
  readonly jobID: string
  /** Defaults to `"model"` for the tool; the reaper/interrupt paths pass their own (spec R14/R20/R32). */
  readonly reason?: CancelReason
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Location-scoped interactive job store: the owner of live jobs, their
 * delivery cursors, spools, and PTY masters (spec R2/R23/R24).
 *
 * Settle contract (spec R10): every method returns at the FIRST matching
 * boundary — `exit`, `quiescence` (quiet window), `chunk-cap` (`tool_output`
 * bounds), `deadline` (bounded wait), or `killed` — and each returned
 * `Result` carries the new output since the previous result plus budget
 * state. There is deliberately NO read/poll method (invariant I2): output is
 * a side effect of acting on the job.
 *
 * Auto-feed (spec R15): every returned result is an ordinary local tool
 * settlement, so the existing V2 runner continuation (durable settlement →
 * `needsContinuation` → next provider turn after reloading projected
 * history) IS the auto-feed cycle. No runner change, no synthetic input, and
 * this service needs no continuation flag — background transitions publish
 * nothing and wait for the next call (spec R16/R17).
 *
 * Serialization (spec R19): calls against one job serialize; a second
 * concurrent call fails fast with `BusyJobError`.
 */
export interface Interface {
  /**
   * Assert permissions happened in the tool; here: governor admission (spec
   * R9), PTY spawn (spec R22), ledger row (spec R30), then settle at the
   * first boundary (spec R10). Spawn failure settles as `failed` with the
   * message in `output` (spec R8).
   */
  readonly start: (request: StartRequest) => Effect.Effect<Result, StoreError>
  /**
   * Append `input` to the child's stdin, optionally signal EOF, then settle
   * at the first boundary. Empty write without `eof` fails (`EmptyWriteError`);
   * terminal/unknown jobs fail per `TerminalJobError`/`UnknownJobError`
   * (spec R11/R12).
   */
  readonly write: (request: WriteRequest) => Effect.Effect<Result, StoreError>
  /**
   * Block for exit until the effective deadline; `timeout` status when it
   * expires alive. Replays an already-terminal job idempotently with empty
   * new output (spec R13).
   */
  readonly wait: (request: WaitRequest) => Effect.Effect<Result, StoreError>
  /**
   * Kill the process group (SIGTERM → SIGKILL after the 3 s grace, close the
   * PTY), mark `cancelled` with the reason (default `"model"`), and return
   * the final drained output. Idempotent on terminal jobs (spec R14). Does
   * not consume an exchange (spec R18).
   */
  readonly cancel: (request: CancelRequest) => Effect.Effect<Result, StoreError>
  /**
   * Drain-interrupt support (spec R32/I10): kill exactly the jobs of this
   * Session that had a call in flight, marking them `cancelled` with the
   * given reason (normally `"interrupt"`); jobs without in-flight calls are
   * untouched.
   */
  readonly cancelInFlight: (request: { readonly sessionID: SessionSchema.ID; readonly reason: CancelReason }) => Effect.Effect<void>
  /**
   * Runtime shutdown (spec R23/R32): kill every live job of the Location
   * with `reason: "session-close"`. Normally registered as a Location
   * finalizer rather than called explicitly.
   */
  readonly killAll: (request: { readonly reason: CancelReason }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/InteractiveJobs") {}

const notImplemented = (what: string) => Effect.die(new Error(`NOT IMPLEMENTED: interactive job store (${what})`))

/** Stub layer: wired into the Location graph together with the implementation (issue item 4). */
export const layer = Layer.succeed(
  Service,
  Service.of({
    start: () => notImplemented("start"),
    write: () => notImplemented("write"),
    wait: () => notImplemented("wait"),
    cancel: () => notImplemented("cancel"),
    cancelInFlight: () => notImplemented("cancelInFlight"),
    killAll: () => notImplemented("killAll"),
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
