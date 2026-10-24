export * as SchedulerCron from "./cron"

/**
 * A parsed standard five-field cron expression (specs/scheduler.md
 * scheduler/cron-spec). This is the canonical stored firing rule of a
 * recurring schedule: field values are the sorted, de-duplicated sets of
 * matching numbers, plus two flags recording whether the day-of-month and
 * day-of-week fields were restricted (non-`*`).
 *
 * Supported syntax per field: `*`, a number, a range `a-b`, a list
 * `a,b,c`, and a step `/n` (star-slash-n, `a/n`, `a-b/n`). Numbers only —
 * month and weekday names are intentionally not accepted, so a named field
 * fails `parse` and surfaces as the tool's `invalid-cron` result.
 * Day-of-week accepts `0` and `7` as Sunday. All evaluation is UTC;
 * daylight-saving arithmetic never applies (spec I2).
 */
export interface Expression {
  readonly minute: ReadonlyArray<number>
  readonly hour: ReadonlyArray<number>
  readonly dayOfMonth: ReadonlyArray<number>
  readonly month: ReadonlyArray<number>
  readonly dayOfWeek: ReadonlyArray<number>
  readonly dayOfMonthRestricted: boolean
  readonly dayOfWeekRestricted: boolean
}

interface FieldSpec {
  readonly min: number
  readonly max: number
}

const MINUTE: FieldSpec = { min: 0, max: 59 }
const HOUR: FieldSpec = { min: 0, max: 23 }
const DAY_OF_MONTH: FieldSpec = { min: 1, max: 31 }
const MONTH: FieldSpec = { min: 1, max: 12 }
const DAY_OF_WEEK: FieldSpec = { min: 0, max: 7 }

const parseInteger = (value: string): number | undefined => {
  if (!/^[0-9]+$/.test(value)) return undefined
  return Number(value)
}

const parseRange = (value: string, spec: FieldSpec): [number, number] | undefined => {
  if (value === "*") return [spec.min, spec.max]
  const bounds = value.split("-")
  if (bounds.length > 2) return undefined
  const start = parseInteger(bounds[0]!)
  if (start === undefined || start < spec.min || start > spec.max) return undefined
  if (bounds.length === 1) return [start, start]
  const end = parseInteger(bounds[1]!)
  if (end === undefined || end < start || end > spec.max) return undefined
  return [start, end]
}

const parseField = (value: string, spec: FieldSpec): ReadonlyArray<number> | undefined => {
  const values = new Set<number>()
  for (const part of value.split(",")) {
    const [rangePart, stepPart] = part.split("/")
    if (rangePart === undefined || rangePart.length === 0 || part.split("/").length > 2) return undefined
    const step = stepPart === undefined ? 1 : parseInteger(stepPart)
    if (step === undefined || step < 1) return undefined
    const range = parseRange(rangePart, spec)
    if (range === undefined) return undefined
    for (let current = range[0]; current <= range[1]; current += step) {
      // Day-of-week accepts 7 as an alias of Sunday (0).
      values.add(spec === DAY_OF_WEEK && current === 7 ? 0 : current)
    }
  }
  if (values.size === 0) return undefined
  return values.values().toArray().sort((left, right) => left - right)
}

/**
 * Parses a standard five-field cron expression.
 *
 * Contract:
 * - `expression` must contain exactly five whitespace-separated fields:
 *   minute (0-59), hour (0-23), day-of-month (1-31), month (1-12),
 *   day-of-week (0-7, 7 normalized to 0). Each field supports `*`, single
 *   values, ranges `a-b`, lists, and steps `/n`; a step value must be a
 *   positive integer.
 * - Returns the parsed `Expression`, or `undefined` when any field is
 *   malformed, out of range, empty, or when the field count is not five.
 * - Never throws; all failure is reported as `undefined` so callers map it to
 *   their own typed error (the tool maps it to `invalid-cron`, spec R3.4).
 */
export const parse = (expression: string): Expression | undefined => {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const minute = parseField(fields[0]!, MINUTE)
  const hour = parseField(fields[1]!, HOUR)
  const dayOfMonth = parseField(fields[2]!, DAY_OF_MONTH)
  const month = parseField(fields[3]!, MONTH)
  const dayOfWeek = parseField(fields[4]!, DAY_OF_WEEK)
  if (minute === undefined || hour === undefined || dayOfMonth === undefined || month === undefined || dayOfWeek === undefined) {
    return undefined
  }
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    dayOfMonthRestricted: fields[2] !== "*",
    dayOfWeekRestricted: fields[4] !== "*",
  }
}

const dayMatches = (expression: Expression, dayOfMonth: number, dayOfWeek: number): boolean => {
  const domHit = expression.dayOfMonth.includes(dayOfMonth)
  const dowHit = expression.dayOfWeek.includes(dayOfWeek)
  if (expression.dayOfMonthRestricted && expression.dayOfWeekRestricted) return domHit || dowHit
  if (expression.dayOfMonthRestricted) return domHit
  if (expression.dayOfWeekRestricted) return dowHit
  return true
}

const matchesDay = (expression: Expression, date: Date): boolean =>
  expression.month.includes(date.getUTCMonth() + 1) &&
  dayMatches(expression, date.getUTCDate(), date.getUTCDay())

/**
 * Reports whether an instant matches an expression.
 *
 * Contract:
 * - `time` is a UTC epoch-millisecond instant; the match evaluates the minute
 *   it falls into (sub-minute parts are ignored).
 * - Day selection follows standard (vixie) cron: when both day-of-month and
 *   day-of-week are restricted the day matches if either matches; when only
 *   one is restricted it must match; when neither is restricted every day
 *   matches.
 * - Total: defined for any epoch-millisecond value.
 */
export const matches = (expression: Expression, time: number): boolean => {
  const date = new Date(Math.floor(time / 60_000) * 60_000)
  return (
    expression.minute.includes(date.getUTCMinutes()) &&
    expression.hour.includes(date.getUTCHours()) &&
    matchesDay(expression, date)
  )
}

// Eight years bridges century leap-year skips (February 29th of 2100 does not
// exist; the next one, 2104, stays within the horizon of any start instant).
const HORIZON_DAYS = 366 * 8 + 2
const DAY_MILLIS = 86_400_000

/**
 * Returns the earliest instant matching the expression strictly after
 * `after`, or `undefined` when no such instant exists.
 *
 * Contract:
 * - `after` is a UTC epoch-millisecond instant; the result is a
 *   minute-aligned epoch-millisecond instant strictly greater than `after`,
 *   or `undefined` when the expression has no match within the scan horizon.
 *   Callers treat `undefined` as "no future match" (the tool maps it to
 *   `cron-without-future-match`, spec R3.5) and as "never fires again" when
 *   advancing a delivered schedule.
 * - The scan is a pure function of its arguments; no clock is read.
 */
export const next = (expression: Expression, after: number): number | undefined => {
  const startMinute = Math.floor(after / 60_000) + 1
  const dayStart = Math.floor(startMinute / 1440) * 1440 * 60_000
  for (let day = 0; day <= HORIZON_DAYS; day++) {
    const current = dayStart + day * DAY_MILLIS
    if (!matchesDay(expression, new Date(current))) continue
    for (const hour of expression.hour) {
      for (const minute of expression.minute) {
        const candidate = current + hour * 3_600_000 + minute * 60_000
        if (candidate >= startMinute * 60_000) return candidate
      }
    }
  }
  return undefined
}

/**
 * Converts an `every` interval into the stored cron-spec (spec R3.3, I1).
 *
 * Contract:
 * - `value` must be a positive integer followed by one of the unit letters
 *   `m`, `h`, `d` (for example `30m`, `1h`, `1d`). Conversion per spec I1:
 *   `n m` to a minute step of n (minute field star-slash-n, all other fields
 *   star), `n h` to hour 0 with an hour step of n, `n d` to hour 0 minute 0
 *   with a day-of-month step of n.
 * - Returns the cron expression string, or `undefined` for any other form —
 *   a missing or zero integer, an unknown unit letter, trailing characters,
 *   or an empty string. Callers map `undefined` to their own typed error
 *   (the tool maps it to `invalid-interval`, spec R3.2).
 * - A step larger than its field range is preserved verbatim (for example
 *   `45m` to a minute step of 45); under standard cron restart semantics such a
 *   step matches only the field minimum, and the add result echoes the
 *   converted form so the model sees the effective rule (spec E3.2).
 */
export const fromEvery = (value: string): string | undefined => {
  const match = /^(\d+)([mhd])$/.exec(value)
  if (match === null) return undefined
  const n = Number(match[1])
  if (n < 1) return undefined
  if (match[2] === "m") return `*/${n} * * * *`
  if (match[2] === "h") return `0 */${n} * * *`
  return `0 0 */${n} * *`
}
