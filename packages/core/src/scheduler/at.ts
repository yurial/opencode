export * as SchedulerAt from "./at"

const PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|z|[+-]\d{2}:\d{2}|[+-]\d{4})?$/

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
