export * as SchedulerMessage from "./message"

/**
 * Literal appended to the fired message of a catch-up fire
 * (specs/scheduler.md Configuration SCHEDULER_CATCH_UP_MARKER, R7.2). Starts
 * with a space so plain concatenation to the message text stays well-formed.
 */
export const CATCH_UP_MARKER = " [catch-up: delivered after the scheduled fire time]"

/**
 * Literal opening the scheduler/gate-output-section of a fired message
 * (specs/scheduler.md Configuration SCHEDULER_GATE_OUTPUT_HEADER, R6.14): a
 * line break, the header text, a line break.
 */
export const GATE_OUTPUT_HEADER = "\ngate command output:\n"

/**
 * Combined-output bound of the scheduler/gate-output-section in characters
 * (specs/scheduler.md Configuration SCHEDULER_MAX_GATE_OUTPUT_LENGTH,
 * R6.14). Longer output is truncated to the bound with an ellipsis
 * character appended.
 */
export const MAX_GATE_OUTPUT_LENGTH = 4096

/** The ellipsis character appended to a truncated scheduler/gate-output-section (R6.14). */
const GATE_ELLIPSIS = "…"

/**
 * Renders a UTC instant in the ISO 8601 form used by the fired-message
 * grammar and every model-facing timestamp (spec E6.6:
 * `2026-10-24T13:00:00Z`).
 *
 * Contract:
 * - `time` is a UTC epoch-millisecond instant.
 * - Returns `YYYY-MM-DDThh:mm:ssZ`; whole-second instants omit the
 *   millisecond part, any other instant keeps it (`...T13:00:00.250Z`).
 * - Total: defined for any epoch-millisecond value; never throws.
 */
export const timestamp = (time: number): string => {
  const iso = new Date(time).toISOString()
  return iso.endsWith(".000Z") ? `${iso.slice(0, 19)}Z` : iso
}

/**
 * Renders the stored spec form of a schedule: the cron-spec for a recurring
 * schedule, or the stored UTC datetime for a one-shot (spec R6.7, fired
 * -message `<spec>` placeholder).
 *
 * Contract:
 * - Pass exactly one of `cron` and `at`; the row invariant "exactly one of
 *   `cron` and `at` is non-null" (specs/scheduler.md Schedule record) makes
 *   the mixed/empty input a programming error, so it throws — do not call
 *   with rows that violate the invariant.
 * - `at` is rendered through `timestamp`.
 */
export const spec = (input: { readonly cron?: string; readonly at?: number }): string => {
  if ((input.cron !== undefined) === (input.at !== undefined)) {
    throw new Error("a schedule spec requires exactly one of cron and at")
  }
  return input.cron !== undefined ? input.cron : timestamp(input.at!)
}

/**
 * Renders the scheduler/gate-echo appended to the add and list success
 * lines of a schedule with a stored gate-command (specs/scheduler.md
 * Interface, gate-echo grammar, R1.4, R1.5):
 *
 *   ` [gate: <command>]`
 *
 * Contract:
 * - `command` is the stored command text; every whitespace run collapses to
 *   a single space in the echo (the stored text itself stays raw).
 * - The fragment starts with a space, never introduces a line break, and is
 *   appended after the `next due` fragment of its line, so the first
 *   `next due` occurrence keeps naming its schedule (the annotator input
 *   contract of scheduler-view, E1.5).
 * - Total: defined for any input; never throws.
 */
export const gateEcho = (command: string): string => ` [gate: ${command.replace(/\s+/g, " ")}]`

/**
 * Renders the scheduler/name-echo that ends the add success line of every
 * add and the list line of every schedule with a non-null name
 * (specs/scheduler.md Interface, name-echo grammar, R1.4, R1.5):
 *
 *   ` [name: <name>]`
 *
 * Contract:
 * - `name` is the stored display name; every whitespace run collapses to a
 *   single space in the echo (the stored text itself stays raw), so the
 *   fragment never introduces a line break.
 * - The fragment is the last fragment of its line: it follows the
 *   scheduler/gate-echo when that echo is present (J14), so the first
 *   `next due` fragment and the first `sch_`-prefixed token of the line keep
 *   naming their schedule (the annotator input contract of scheduler-view).
 * - Total: defined for any input; never throws.
 */
export const nameEcho = (name: string): string => ` [name: ${name.replace(/\s+/g, " ")}]`

/**
 * Renders the scheduler/gate-output-section appended to a fired message
 * whose gate-run exited with status zero and wrote output
 * (specs/scheduler.md Interface, fired-message grammar, R6.14):
 *
 *   `<GATE_OUTPUT_HEADER><combined output>`
 *
 * Contract:
 * - `output` is the combined standard output and error of the run.
 * - The output is trimmed of leading and trailing whitespace; a run wrote
 *   output exactly when the trimmed text is non-empty — an empty or
 *   whitespace-only run yields no section (empty string).
 * - Longer output is truncated to MAX_GATE_OUTPUT_LENGTH characters with
 *   GATE_ELLIPSIS appended when truncation occurs.
 * - Total: defined for any input; never throws.
 */
export const gateOutputSection = (output: string): string => {
  const trimmed = output.trim()
  if (trimmed.length === 0) return ""
  const capped =
    trimmed.length > MAX_GATE_OUTPUT_LENGTH ? trimmed.slice(0, MAX_GATE_OUTPUT_LENGTH) + GATE_ELLIPSIS : trimmed
  return `${GATE_OUTPUT_HEADER}${capped}`
}

/**
 * Renders the fired message delivered by a fire, following the fixed
 * fired-message grammar (specs/scheduler.md Interface, R6.6):
 *
 *   `<scheduled-fire-time> fired schedule id <id> <spec>: <message><catch-up-marker><gate-output-section>`
 *
 * Contract:
 * - `scheduledFireAt` is the UTC epoch-millisecond instant of the discharged
 *   occurrence — the stored next-due-time at fire initiation, stable across
 *   delivery retries (J7).
 * - `id` is the schedule id, `spec` the spec form (see `spec`), `message`
 *   the stored message text.
 * - `catchUp` appends `CATCH_UP_MARKER` exactly when true; a normal fire
 *   never carries the marker (R7.2).
 * - `gateOutput`, when given, is the combined output of the permitted
 *   gate-run; it renders through `gateOutputSection` and is appended after
 *   the catch-up marker (R6.14). Suppressed fires never reach this renderer
 *   — their output is discarded.
 * - Total: defined for any input; never throws.
 */
export const fired = (input: {
  readonly scheduledFireAt: number
  readonly id: string
  readonly spec: string
  readonly message: string
  readonly catchUp: boolean
  readonly gateOutput?: string
}): string =>
  `${timestamp(input.scheduledFireAt)} fired schedule id ${input.id} ${input.spec}: ${input.message}${input.catchUp ? CATCH_UP_MARKER : ""}${input.gateOutput === undefined ? "" : gateOutputSection(input.gateOutput)}`

/**
 * Renders the add result line: the schedule id, the spec form, and the next
 * due time in UTC (spec R1.4). A schedule stored with a gate-command places
 * the gate-echo (`command`, see `gateEcho`) immediately before the
 * scheduler/name-echo that ends the line (`name`, see `nameEcho`).
 */
export const added = (entry: {
  readonly id: string
  readonly spec: string
  readonly nextFireAt: number
  readonly command?: string
  readonly name?: string
}): string =>
  `Scheduled ${entry.id} (${entry.spec}), next due ${timestamp(entry.nextFireAt)}${entry.command === undefined ? "" : gateEcho(entry.command)}${entry.name === undefined ? "" : nameEcho(entry.name)}`

/**
 * Renders one list result line: the schedule id, the spec form, the next due
 * time in UTC, and the message text (spec R1.5). The list result joins these
 * lines with newlines; no schedules yields an empty listing. A schedule
 * stored with a gate-command ends its line with the gate-echo (`command`,
 * see `gateEcho`); a schedule with a non-null name ends its line with the
 * scheduler/name-echo (`name`, see `nameEcho`) — a legacy schedule with a
 * null name (`name` undefined) carries no name fragment.
 */
export const listed = (entry: {
  readonly id: string
  readonly spec: string
  readonly nextFireAt: number
  readonly message: string
  readonly command?: string
  readonly name?: string
}): string =>
  `${entry.id} (${entry.spec}) next due ${timestamp(entry.nextFireAt)}: ${entry.message}${entry.command === undefined ? "" : gateEcho(entry.command)}${entry.name === undefined ? "" : nameEcho(entry.name)}`

/**
 * Renders the remove result line confirming the removed schedule id
 * (spec R1.6).
 */
export const removed = (id: string): string => `Removed schedule ${id}`
