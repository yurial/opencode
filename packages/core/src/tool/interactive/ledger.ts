export * as InteractiveLedger from "./ledger"

import { Schema } from "effect"
import { Context, Effect, Layer } from "effect"
import { NonNegativeInt, PositiveInt } from "../../schema"
import { makeLocationNode } from "../../effect/app-node"

/**
 * One row of the per-Location job ledger (spec R30). Exactly the minimum
 * needed to reap orphans after a crash: which process group was spawned, for
 * which Session, when. Rows are deleted on the job's terminal transition —
 * the ledger is a side file, not durable session events (L8).
 */
export const Row = Schema.Struct({
  jobID: Schema.String,
  sessionID: Schema.String,
  pgid: PositiveInt,
  startedAt: NonNegativeInt,
})
export type Row = typeof Row.Type

/**
 * Orphan ledger (spec R30). The store keeps one managed file per Location,
 * `interactive/<location-key>/jobs.json`, atomically rewritten on every
 * mutation. Invariant I9: before any NEW job spawns in a Location, `sweep`
 * has killed every recorded process group still alive (SIGTERM → SIGKILL
 * grace, rows dropped) — orphan cleanup does not wait for the owning Session
 * to be reopened. After a crash there is no job replay (spec R31): the sweep
 * is the only recovery, and calls still projected `running` are durably
 * failed by the existing `failInterruptedTools` rule.
 */
export interface Interface {
  /** Atomically upsert the row for a live job. Called right after spawn. */
  readonly record: (row: Row) => Effect.Effect<void, LedgerError>
  /** Drop the row on the job's terminal transition. Missing rows are ignored. */
  readonly remove: (jobID: string) => Effect.Effect<void, LedgerError>
  /**
   * Kill every recorded process group still alive and drop all rows.
   * Returns how many orphans were reaped. Runs at Location startup, before
   * any new spawn (invariant I9), and is idempotent.
   */
  readonly sweep: () => Effect.Effect<number, LedgerError>
}

export class LedgerError extends Schema.TaggedErrorClass<LedgerError>()("InteractiveLedger.Error", {
  operation: Schema.Literals(["record", "remove", "sweep"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Interactive ledger ${this.operation} failed${detail ? `: ${detail}` : ""}`
  }
}

export type Error = LedgerError

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/InteractiveLedger") {}

const notImplemented = Effect.die(new Error("NOT IMPLEMENTED: interactive orphan ledger"))

/** Stub layer: wired into the Location graph together with the implementation (issue item 4). */
export const layer = Layer.succeed(
  Service,
  Service.of({
    record: () => notImplemented,
    remove: () => notImplemented,
    sweep: () => notImplemented,
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
