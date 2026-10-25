export * as SchedulerAt from "./at"

const PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|z|[+-]\d{2}:\d{2}|[+-]\d{4})?$/

const DURATION_PATTERN = /^now\+(\d+)([smhd])$/
const CLOCK_PATTERN = /^now\+(\d{2}):(\d{2}):(\d{2})$/

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate()

/**
 * Parses an ISO 8601 datetime into a UTC epoch-millisecond instant
 * (specs/scheduler.md R3.6, R3.7).
 *
 * Contract:
 * - `value` must be a datetime of the form `YYYY-MM-DDThh:mm[:ss[.mmm]]`
 *   (the `T` separator may also be a space or lowercase `t`; seconds and
 *   milliseconds are optional; lowercase `z` is accepted for `Z`). A
 *   date-only string is rejected: the spec domain is a datetime, not a date.
 * - `localOffsetAt` resolves the process timezone for naive values: it maps
 *   a UTC epoch-millisecond instant to the local zone's offset from UTC in
 *   milliseconds (east positive, the negation of `Date#getTimezoneOffset`
 *   scaled to milliseconds). Inject it rather than reading clocks here so
 *   resolution is testable; pass `(time) => -new Date(time).getTimezoneOffset() * 60000`
 *   in production wiring.
 * - A zoned value (explicit `Z` or `±hh:mm` offset) resolves to the UTC
 *   equivalent of its offset, independent of `localOffsetAt`; a naive value
 *   resolves in the process timezone at the resolved instant (two-pass DST
 *   correction, so a value landing on a DST boundary uses the offset in
 *   effect at that wall time).
 * - Returns the epoch-millisecond instant, or `undefined` when the value is
 *   unparseable, uses an out-of-range component (month 0 or 13, day 32,
 *   hour 24, minute 60, a second 60, a malformed offset), or is truncated.
 * - Never throws; all failure is reported as `undefined` so callers map it
 *   to their own typed error (the tool maps it to `invalid-at`, spec R3.6).
 *   Past/instant comparisons are the caller's concern (the tool maps a
 *   resolved instant not after the current time to `at-in-past`, R3.8).
 */
export const parse = (value: string, localOffsetAt: (time: number) => number): number | undefined => {
  const match = PATTERN.exec(value)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = match[6] === undefined ? 0 : Number(match[6])
  const millis = match[7] === undefined ? 0 : Number(match[7].padEnd(3, "0"))
  if (month < 1 || month > 12) return undefined
  if (day < 1 || day > daysInMonth(year, month)) return undefined
  if (hour > 23 || minute > 59 || second > 59) return undefined
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millis)

  const zone = match[8]
  if (zone === undefined) {
    // Naive: read as process-local wall time. The first pass guesses with the
    // offset at the wall-as-UTC instant; the second pass corrects the guess
    // when that instant sits on the far side of a DST flip.
    const firstOffset = localOffsetAt(wallAsUtc)
    const secondOffset = localOffsetAt(wallAsUtc - firstOffset)
    return wallAsUtc - secondOffset
  }
  if (zone === "Z" || zone === "z") return wallAsUtc
  const sign = zone[0] === "-" ? -1 : 1
  const digits = zone.slice(1).replace(":", "")
  const offsetHours = Number(digits.slice(0, 2))
  const offsetMinutes = Number(digits.slice(2, 4))
  if (offsetHours > 23 || offsetMinutes > 59) return undefined
  return wallAsUtc - sign * (offsetHours * 3_600_000 + offsetMinutes * 60_000)
}

/**
 * Parses a relative `now+…` offset into a duration in milliseconds
 * (specs/scheduler.md R3.6, relative `at` forms).
 *
 * Contract:
 * - `value` must be exactly one of the two accepted forms, with no internal
 *   or surrounding whitespace and nothing after the last component:
 *   `now+<positive integer><unit>` with the unit letter one of `s`, `m`,
 *   `h`, `d` (for example `now+5m`, `now+90s`), or the clock form
 *   `now+HH:MM:SS` of three two-digit groups where the hours come first and
 *   may exceed 24 (00-99), minutes are 00-59, and seconds are 00-59 (for
 *   example `now+01:30:25` is 1h 30m 25s).
 * - Returns the offset in milliseconds, or `undefined` for any other form —
 *   a missing or zero amount, an unknown unit letter, a truncated or
 *   over-long clock form, an out-of-range minute or second.
 * - Pure: no clock is read; callers resolve the offset against the current
 *   time at add time (the tool adds it to the current epoch and stores the
 *   absolute instant, never the relative form).
 * - Never throws; all failure is reported as `undefined`, matching `parse`.
 */
export const relativeParse = (value: string): number | undefined => {
  const duration = DURATION_PATTERN.exec(value)
  if (duration !== null) {
    const amount = Number(duration[1])
    if (amount < 1) return undefined
    const unit = duration[2]
    return amount * (unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000)
  }
  const clock = CLOCK_PATTERN.exec(value)
  if (clock === null) return undefined
  const hour = Number(clock[1])
  const minute = Number(clock[2])
  const second = Number(clock[3])
  if (minute > 59 || second > 59) return undefined
  return hour * 3_600_000 + minute * 60_000 + second * 1_000
}
