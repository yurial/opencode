export * as SchedulerMessage from "./message"

/**
 * Literal appended to the fired message of a catch-up fire
 * (specs/scheduler.md Configuration SCHEDULER_CATCH_UP_MARKER, R7.2). Starts
 * with a space so plain concatenation to the message text stays well-formed.
 */
export const CATCH_UP_MARKER = " [catch-up: delivered after the scheduled fire time]"

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
 * Renders the fired message delivered by a fire, following the fixed
 * fired-message grammar (specs/scheduler.md Interface, R6.6):
 *
 *   `<scheduled-fire-time> fired schedule id <id> <spec>: <message><catch-up-marker>`
 *
 * Contract:
 * - `scheduledFireAt` is the UTC epoch-millisecond instant of the discharged
 *   occurrence — the stored next-due-time at fire initiation, stable across
 *   delivery retries (J7).
 * - `id` is the schedule id, `spec` the spec form (see `spec`), `message`
 *   the stored message text.
 * - `catchUp` appends `CATCH_UP_MARKER` exactly when true; a normal fire
 *   never carries the marker (R7.2).
 * - Total: defined for any input; never throws.
 */
export const fired = (input: {
  readonly scheduledFireAt: number
  readonly id: string
  readonly spec: string
  readonly message: string
  readonly catchUp: boolean
}): string =>
  `${timestamp(input.scheduledFireAt)} fired schedule id ${input.id} ${input.spec}: ${input.message}${input.catchUp ? CATCH_UP_MARKER : ""}`

/**
 * Renders the add result line: the schedule id, the spec form, and the next
 * due time in UTC (spec R1.4).
 */
export const added = (entry: { readonly id: string; readonly spec: string; readonly nextFireAt: number }): string =>
  `Scheduled ${entry.id} (${entry.spec}), next due ${timestamp(entry.nextFireAt)}`

/**
 * Renders one list result line: the schedule id, the spec form, the next due
 * time in UTC, and the message text (spec R1.5). The list result joins these
 * lines with newlines; no schedules yields an empty listing.
 */
export const listed = (entry: {
  readonly id: string
  readonly spec: string
  readonly nextFireAt: number
  readonly message: string
}): string => `${entry.id} (${entry.spec}) next due ${timestamp(entry.nextFireAt)}: ${entry.message}`

/**
 * Renders the remove result line confirming the removed schedule id
 * (spec R1.6).
 */
export const removed = (id: string): string => `Removed schedule ${id}`
