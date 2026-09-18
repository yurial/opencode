export * as InteractiveSpool from "./spool"

import { Context, Effect, Layer, Schema } from "effect"
import type { ID } from "./job"
import { makeLocationNode } from "../../effect/app-node"

/**
 * One bounded read from the spool between two byte offsets (spec R25).
 * `text` is the decoded chunk bounded by the `tool_output.max_lines` /
 * `max_bytes` limits; `truncated` marks that the cap was hit — elided bytes
 * are NOT re-delivered later, callers advance to `nextCursor` and page the
 * spool file (via the `read` tool) instead; `nextCursor` is the absolute end
 * offset after this read (monotonic delivery cursor, spec I6).
 */
export interface Chunk {
  readonly text: string
  readonly truncated: boolean
  readonly nextCursor: number
}

/**
 * Spool manager (spec R24). Every job continuously appends its combined
 * output to ONE managed file `<data>/tool-output/tool_ijob_<id>` — the
 * ToolOutputStore directory and naming prefix, so the existing 7-day
 * retention applies — capped at `interactive.max_spool_bytes` (default
 * 8 MiB); past the cap `append` stops storing bytes and reports `capped`.
 * The `outputPath` of every interactive result names this file. Spools are
 * never deleted by the manager; retention is ToolOutputStore's.
 */
export interface Interface {
  /**
   * Create (or re-attach to) the managed spool file for a job and return its
   * absolute path. Called once per job by the job store before the child
   * spawns; the path goes into every result's `outputPath`.
   */
  readonly open: (jobID: ID) => Effect.Effect<string, StorageError>
  /**
   * Append bytes to the job's spool. Returns how many bytes were actually
   * stored (0 past the cap), whether the cap has been reached (sticky), and
   * the spool's total stored size in bytes.
   */
  readonly append: (
    jobID: ID,
    bytes: Uint8Array,
  ) => Effect.Effect<{ bytesStored: number; capped: boolean; totalBytes: number }, StorageError>
  /**
   * Read the stored range `[from, to)` as UTF-8 text bounded by the
   * `tool_output` limits (spec R25). `to === undefined` reads to the current
   * end. UB if `from` exceeds the stored size.
   */
  readonly slice: (
    jobID: ID,
    from: number,
    to: number | undefined,
    limits: { maxLines: number; maxBytes: number },
  ) => Effect.Effect<Chunk, StorageError>
}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("InteractiveSpool.StorageError", {
  operation: Schema.Literals(["open", "append", "slice"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Failed to ${this.operation} interactive spool${detail ? `: ${detail}` : ""}`
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/InteractiveSpool") {}

const notImplemented = Effect.die(new Error("NOT IMPLEMENTED: interactive spool manager"))

/** Stub layer: wired into the Location graph together with the implementation (issue item 4). */
export const layer = Layer.succeed(
  Service,
  Service.of({
    open: () => notImplemented,
    append: () => notImplemented,
    slice: () => notImplemented,
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
