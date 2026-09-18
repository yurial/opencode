export * as InteractiveTool from "./interactive"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PositiveInt } from "../schema"
import { InteractiveJob } from "./interactive/job"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

/**
 * The V2 `interactive` tool family (specs/tool-interactive.md): four sibling
 * registrations — `interactive_start`, `interactive_write`,
 * `interactive_wait`, `interactive_cancel` — that run long-lived interactive
 * child processes (gdb, REPLs, installers) as jobs surviving across provider
 * turns and auto-feed their output to the model. There is no read/poll
 * method (invariant I2): every settled result carries the output since the
 * previous result plus a status, and the existing V2 runner continuation
 * (durable settlement → `needsContinuation`) is the auto-feed cycle
 * (spec R15) — no runner change.
 *
 * All four share the `interactive` permission key (spec R28): one blanket
 * deny hides the whole family, only `start` asserts permissions (spec
 * R26/R27/I7), and a declined start halts the drain like bash.
 *
 * SCAFFOLD (issue item 1): executes are loud `NOT IMPLEMENTED` stubs. The
 * only concrete logic is the pure R4 `toModelOutput` formatter. The job
 * store, PTY runtime, spool, ledger, and governor live in `./interactive/`
 * as stub services to be wired in with the implementation (issue item 4).
 */

export const START = "interactive_start"
export const WRITE = "interactive_write"
export const WAIT = "interactive_wait"
export const CANCEL = "interactive_cancel"

/** All four names, in registration order. */
export const names = [START, WRITE, WAIT, CANCEL] as const

/** Shared family permission key (spec R28/I7). */
export const PERMISSION_KEY = "interactive"

// ---------------------------------------------------------------------------
// Inputs (flat provider-facing schemas, spec R1/R7/R11/R13/R14)
// ---------------------------------------------------------------------------

export const StartInput = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory. Defaults to the active Location; relative paths resolve from that Location.",
  }),
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(InteractiveJob.MAX_JOB_LIFETIME_MS))
    .pipe(Schema.optional)
    .annotate({
      description: `Job lifetime in milliseconds. Defaults to interactive.default_timeout_ms (${InteractiveJob.DEFAULT_JOB_LIFETIME_MS}) and may not exceed ${InteractiveJob.MAX_JOB_LIFETIME_MS}.`,
    }),
})

export const WriteInput = Schema.Struct({
  jobID: Schema.String.annotate({ description: "Job ID returned by interactive_start" }),
  input: Schema.String.annotate({
    description: 'Exact bytes appended to the child\'s stdin; include the trailing "\\n" yourself',
  }),
  eof: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Signal end-of-input (^D on the PTY) after writing",
  }),
})

export const WaitInput = Schema.Struct({
  jobID: Schema.String.annotate({ description: "Job ID returned by interactive_start" }),
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(InteractiveJob.MAX_WAIT_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({
      description: `Deadline in milliseconds. Defaults to interactive.wait_timeout_ms (${InteractiveJob.DEFAULT_WAIT_TIMEOUT_MS}) and may not exceed ${InteractiveJob.MAX_WAIT_TIMEOUT_MS}.`,
    }),
})

export const CancelInput = Schema.Struct({
  jobID: Schema.String.annotate({ description: "Job ID returned by interactive_start" }),
})

// ---------------------------------------------------------------------------
// Model guidance (spec R33, verbatim block with budgets interpolated)
// ---------------------------------------------------------------------------

const GUIDANCE = `Use the interactive tools only for processes that need a conversation:
debuggers (gdb), REPLs (python, node), interactive installers, anything
that prints a prompt and waits. For one-shot commands use bash instead —
it is faster and cheaper; never use interactive tools to poll output.

Rules:
- Every result returns new output plus a status. waiting = the process
  awaits your input (send interactive_write). running = output was cut at
  the size cap; the full stream is at outputPath (use the read tool to
  page it). timeout = your interactive_wait deadline expired, the process
  still lives. done/failed/cancelled are final.
- interactive_write input must contain what you would type, including the
  trailing "\\n". Never send an empty write; there is no way and no need
  to poll for output.
- Finish every job with exactly one terminal action: interactive_wait to
  let it exit (pass a timeout when it may be slow) or interactive_cancel
  to kill it. Do not leave jobs open when you are done with them.
- Each interaction costs one provider turn and jobs are limited to ${InteractiveJob.DEFAULT_MAX_EXCHANGES} exchanges and ${InteractiveJob.DEFAULT_MAX_JOBS} concurrent jobs per session;
  when a job exceeds its budget the runtime cancels it and tells you.
  Batch related work into fewer, larger writes.`

const START_SUPPLEMENT = `${START} spawns the process as a job and returns the first settled
result: an initial banner/prompt settles waiting, a chatty process settles
running, an immediate crash settles done/failed with the early output. Spawn
failures are reported as status failed (message in output), not as a tool
error, so you can react.`

const WRITE_SUPPLEMENT = `${WRITE} appends input to the job's stdin (set eof: true to also signal
end-of-input) and returns the next settled result. Unknown job IDs fail:
jobs do not survive runtime restarts.`

const WAIT_SUPPLEMENT = `${WAIT} blocks until the job exits (final done/failed result), its
deadline expires (status timeout, the process still lives), or the output
cap cuts the result (status running). On an already-terminal job it replays
the final result idempotently with empty new output.`

const CANCEL_SUPPLEMENT = `${CANCEL} kills the job's process group (SIGTERM, then SIGKILL) and
returns the final drained output plus the spool path. Idempotent on
terminal jobs. Cancelling does not consume an exchange.`

// ---------------------------------------------------------------------------
// Shared model text (spec R4)
// ---------------------------------------------------------------------------

/**
 * Pure R4 formatter: the bounded `output` text, the status line
 * `[interactive <jobID> status=<status> exchanges=<n>/<max>]`, terminal
 * `exit`/`reason` notes, and — when bytes were elided — the spool marker
 * naming `outputPath` (invariant I5). The truncation marker is emitted here
 * because interactive results are self-bounded (spec R25): the generic
 * settlement bounding no-ops on them.
 */
const toModelOutput = ({ output }: { readonly output: InteractiveJob.Result }): ReadonlyArray<Tool.Content> => {
  const total = output.exchanges + output.exchangesRemaining
  const parts = [
    output.output,
    `[interactive ${output.jobID} status=${output.status} exchanges=${output.exchanges}/${total}]`,
    ...(output.exit !== undefined ? [`Process exited with code ${output.exit}.`] : []),
    ...(output.reason !== undefined ? [`Job cancelled (reason: ${output.reason}).`] : []),
    ...(output.truncated ? [`... output truncated; full output saved to ${output.outputPath} ...`] : []),
  ]
  return parts
    .filter((part) => part !== "")
    .map((text) => ({ type: "text" as const, text }))
}

// ---------------------------------------------------------------------------
// Registration (four sibling registrations, spec R1; execute stubs)
// ---------------------------------------------------------------------------

const notImplemented = (method: string) => Effect.die(new Error(`NOT IMPLEMENTED: interactive tool (${method})`))

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools
      .register({
        [START]: Tool.withPermission(
          Tool.make({
            description: `${GUIDANCE}\n\n${START_SUPPLEMENT}`,
            input: StartInput,
            output: InteractiveJob.Result,
            toModelOutput,
            execute: () => notImplemented(START),
          }),
          PERMISSION_KEY,
        ),
        [WRITE]: Tool.withPermission(
          Tool.make({
            description: `${GUIDANCE}\n\n${WRITE_SUPPLEMENT}`,
            input: WriteInput,
            output: InteractiveJob.Result,
            toModelOutput,
            execute: () => notImplemented(WRITE),
          }),
          PERMISSION_KEY,
        ),
        [WAIT]: Tool.withPermission(
          Tool.make({
            description: `${GUIDANCE}\n\n${WAIT_SUPPLEMENT}`,
            input: WaitInput,
            output: InteractiveJob.Result,
            toModelOutput,
            execute: () => notImplemented(WAIT),
          }),
          PERMISSION_KEY,
        ),
        [CANCEL]: Tool.withPermission(
          Tool.make({
            description: `${GUIDANCE}\n\n${CANCEL_SUPPLEMENT}`,
            input: CancelInput,
            output: InteractiveJob.Result,
            toModelOutput,
            execute: () => notImplemented(CANCEL),
          }),
          PERMISSION_KEY,
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/interactive",
  layer,
  deps: [ToolRegistry.node],
})
