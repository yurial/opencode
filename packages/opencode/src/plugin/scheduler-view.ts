import type { Hooks, PluginInput } from "@opencode-ai/plugin"

/**
 * Reads the scheduler-view/eta-clock: the current UTC instant of the
 * rendering process, as UTC epoch milliseconds (specs/scheduler-view.md,
 * Definitions, scheduler-view/eta-clock).
 *
 * Contract:
 * - Returns a finite integer of UTC epoch milliseconds; the annotated due
 *   instants are compared against it as-is.
 * - Called once per annotated line, at annotation time (R1.6); the clock is
 *   read after the due instant of the line is known.
 * - A clock that throws or returns a non-finite value is an annotator
 *   failure: the hook catches it and leaves the tool result untouched
 *   (R1.9). There is no other error channel.
 */
export type EtaClock = () => number

/**
 * Options of the scheduler-view/annotator plugin.
 */
export type SchedulerViewPluginOptions = {
  /**
   * The scheduler-view/eta-clock used to derive every scheduler-view/eta of
   * the annotation pass (R2.1).
   *
   * Contract:
   * - Allowed values: any `EtaClock` — a function returning the current UTC
   *   instant in epoch milliseconds (see `EtaClock` for its contract).
   * - Omitted (the internal-plugins registration passes no options): the UTC
   *   clock of the server host process — `Date.now` (R1.6).
   * - The injection point exists for tests: a fixed clock makes every eta
   *   rendering of the annotation pass deterministic.
   */
  etaClock?: EtaClock
}

/**
 * The scheduler-view/annotator (specs/scheduler-view.md R1): a builtin host
 * plugin that appends one scheduler-view/annotation-line per
 * `next due <instant>` fragment of a completed scheduler tool result
 * (R1.3, R1.4).
 *
 * Contract:
 * - Registers through the internal-plugins list of the server host process
 *   and enables and disables together with the other internal plugins
 *   (R1.1); there is no plugin-config key.
 * - Hook `tool.execute.after`; only calls whose tool name is `scheduler`
 *   are annotated (R1.2 — add, list, and remove alike); every other tool
 *   passes through unchanged.
 * - Data source is exclusively the output text of the passed result
 *   (R1.7): no scheduler/service and no schedule storage is queried.
 * - Annotation lines append after the tool's own output text in the order
 *   the fragments appear (R1.4); no line of the tool's own text, the title,
 *   and the metadata change (R1.5).
 * - Never rejects and never fails the tool call: an internal failure of the
 *   annotator appends nothing and leaves the result exactly as the
 *   scheduler tool produced it (R1.9).
 */
export async function SchedulerViewPlugin(_input: PluginInput, options: SchedulerViewPluginOptions = {}): Promise<Hooks> {
  const etaClock = options.etaClock ?? hostEtaClock
  return {
    "tool.execute.after": async (call, result) => {
      if (call.tool !== SCHEDULER_TOOL_NAME) return
      // R1.9: any annotator failure appends nothing and leaves the
      // completed result exactly as the scheduler tool produced it.
      try {
        annotate(result, etaClock)
      } catch {}
    },
  }
}

/**
 * Appends one annotation line per `next due <instant>` fragment of the
 * result text, in text order (R1.3, R1.4). Touches nothing but the output
 * text: the title and the metadata of the result object are never read for
 * writing (R1.5).
 */
function annotate(result: { output: string }, etaClock: EtaClock): void {
  const lines = result.output.split("\n").flatMap((line) => {
    const annotation = annotateLine(line, etaClock)
    return annotation === undefined ? [] : [annotation]
  })
  if (lines.length === 0) return
  result.output = `${result.output}\n${lines.join("\n")}`
}

/**
 * Renders the annotation line of one output line, or `undefined` when the
 * line carries no `next due <instant>` fragment (I2): the schedule id is
 * the first `sch_`-prefixed token of the line, the due instant the token
 * that immediately follows the fragment. The instant must match the fixed
 * output form of scheduler.md R1.4/R1.5 (ISO 8601 UTC; in list lines the
 * instant is followed by the `:` that separates the message text); any
 * other follower token means no `next due <instant>` fragment and no
 * annotation line (R1.3). A shape-conforming token that parses as no
 * instant — calendar-invalid components — is skipped alike (defensive; the
 * tool never emits one).
 */
function annotateLine(line: string, etaClock: EtaClock): string | undefined {
  const at = line.indexOf(NEXT_DUE_FRAGMENT)
  if (at === -1) return
  const id = SCHEDULE_ID_PATTERN.exec(line)?.[0]
  const dueText = DUE_INSTANT_PATTERN.exec(line.slice(at + NEXT_DUE_FRAGMENT.length))?.[1]
  if (id === undefined || dueText === undefined) return
  const due = Date.parse(dueText)
  if (Number.isNaN(due)) return
  return `eta ${id}: ${eta(due, etaClock())} (${absolute(due)})`
}

/**
 * Renders the scheduler-view/eta of one due instant against the eta-clock
 * reading (R2.1-R2.4): a remainder at or below zero renders `now`, a
 * remainder below one minute the seconds production, a remainder of one
 * minute or more the hour-minute production with unpadded hours and
 * two-digit minutes.
 */
function eta(due: number, now: number): string {
  const remainder = due - now
  if (remainder <= ETA_NOW_BOUND_MS) return "now"
  if (remainder < ETA_MINUTE_MS) return `in ${Math.floor(remainder / ETA_SECOND_MS)}s`
  const hours = Math.floor(remainder / ETA_HOUR_MS)
  const minutes = Math.floor((remainder % ETA_HOUR_MS) / ETA_MINUTE_MS)
  return `in ${hours}h ${String(minutes).padStart(2, "0")}m`
}

/**
 * Renders the due instant as the absolute time of the annotation line: the
 * ISO 8601 UTC form of second precision, the sub-second part truncated
 * (R2.5).
 */
function absolute(due: number): string {
  return `${new Date(due).toISOString().slice(0, ISO_SECOND_LENGTH)}Z`
}

/**
 * The default scheduler-view/eta-clock: the UTC clock of the server host
 * process (R1.6).
 */
const hostEtaClock: EtaClock = () => Date.now()

/**
 * Boundaries of the scheduler-view/eta grammar (specs/scheduler-view.md,
 * ETA grammar): a remainder at or below ETA_NOW_BOUND_MS renders `now`
 * (R2.2), a remainder below ETA_MINUTE_MS renders the seconds production
 * (R2.3), a remainder of ETA_MINUTE_MS or more renders the hour-minute
 * production, floored on ETA_HOUR_MS (R2.4). Fixed values — the spec has no
 * config key for them.
 */
const ETA_NOW_BOUND_MS = 0
const ETA_MINUTE_MS = 60_000
const ETA_HOUR_MS = 3_600_000
const ETA_SECOND_MS = 1_000

/**
 * Length of `YYYY-MM-DDTHH:MM:SS`, the second-precision head of an ISO 8601
 * UTC string (R2.5).
 */
const ISO_SECOND_LENGTH = 19

const SCHEDULER_TOOL_NAME = "scheduler"

/**
 * The `next due` fragment the annotator scans every output line for
 * (scheduler-view I2); the due instant is the token that follows it
 * (scheduler.md R1.4, R1.5 fix its ISO 8601 UTC form).
 */
const NEXT_DUE_FRAGMENT = "next due"

/**
 * A `sch_`-prefixed schedule id token (specs/scheduler.md Definitions,
 * scheduler/schedule; the id is the `sch_` prefix over an ascending
 * identifier of alphanumerics).
 */
const SCHEDULE_ID_PATTERN = /sch_[A-Za-z0-9]+/

/**
 * The due instant of a `next due <instant>` fragment, anchored to the text
 * right after the fragment (leading whitespace, then the instant): the ISO
 * 8601 UTC form fixed by scheduler.md R1.4/R1.5 — second precision with an
 * optional sub-second part, closed by the `Z` designator. Anchoring keeps
 * the trailing `:` of a list line out of the instant.
 */
const DUE_INSTANT_PATTERN = /^\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/

export * as SchedulerView from "./scheduler-view"
