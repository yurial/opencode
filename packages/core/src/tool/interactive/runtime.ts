export * as InteractiveProcess from "./runtime"

import { Context, Effect, Layer, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { Duration } from "effect"
import { makeLocationNode } from "../../effect/app-node"

/**
 * How the child's exit was observed (spec R5). `exitCode` is the numeric exit
 * status; `signal` names a fatal signal when the child was killed instead of
 * exiting on its own. A spawn failure is not an exit — it fails `spawn`.
 */
export interface ExitStatus {
  readonly exitCode?: number
  readonly signal?: string
}

/**
 * One live interactive child (spec R22): spawned under a PTY on POSIX in its
 * own process group so prompt/isatty-dependent programs behave; Windows falls
 * back to pipes (L4). stdout and stderr arrive merged on `output`.
 *
 * Ownership contract (spec R23): the job store owns the returned child —
 * callers must eventually `kill` it or consume `exit`; the runtime closing
 * all masters (children receive SIGHUP) plus the ledger startup sweep
 * (spec R30) are the backstops for children that survive. The service is a
 * port so tests substitute a scripted fake child (spec R34).
 */
export interface Child {
  /** Process group id of the child; recorded in the orphan ledger (spec R30). */
  readonly pgid: number
  /** Merged (stdout+stderr) byte stream from the PTY master. */
  readonly output: Stream.Stream<Uint8Array, PlatformError>
  /**
   * Append exact bytes to the child's stdin (the PTY master). The caller
   * includes the trailing newline; `signalEof` sends ^D separately.
   */
  readonly write: (bytes: string) => Effect.Effect<void, PlatformError>
  /** Signal end-of-input (^D on the PTY) after pending writes. */
  readonly signalEof: () => Effect.Effect<void>
  /** Completes once when the child exits; safe to race against settle timers. */
  readonly exit: Effect.Effect<ExitStatus>
  /**
   * Kill the whole process group: SIGTERM, then SIGKILL after `grace`
   * (default 3 s, matching bash), then close the PTY master. Idempotent.
   */
  readonly kill: (grace?: Duration.Input) => Effect.Effect<void>
}

/** Spawn request executed like bash's: a shell command string under `shell`. */
export interface SpawnRequest {
  readonly command: string
  readonly shell?: string
  readonly cwd: string
  readonly env?: Record<string, string>
}

export class SpawnError extends Schema.TaggedErrorClass<SpawnError>()("InteractiveProcess.SpawnError", {
  command: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Failed to spawn interactive process: ${this.command}${detail ? `: ${detail}` : ""}`
  }
}

/**
 * PTY spawn port (spec R22/R34). `pty` reports whether the live layer can
 * provide a real PTY (`true` on POSIX, `false` on the Windows pipes fallback,
 * L4) so the job store can annotate behavior. Tests replace the whole service
 * with a fake child replaying scripted `(bytes, delay)` events.
 */
export interface Interface {
  readonly pty: boolean
  readonly spawn: (request: SpawnRequest) => Effect.Effect<Child, SpawnError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/InteractiveProcess") {}

const notImplemented = Effect.die(new Error("NOT IMPLEMENTED: interactive process runtime (PTY spawn)"))

/** Stub layer: every spawn dies loudly until the implementation lands (issue item 4). */
export const layer = Layer.succeed(Service, Service.of({ pty: false, spawn: () => notImplemented }))

export const node = makeLocationNode({ service: Service, layer, deps: [] })
