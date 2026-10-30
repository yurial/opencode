export * as Zone from "./zone"

/**
 * Explicit zone offset form accepted alongside IANA names: `±HH:MM`, `±HHMM`,
 * or `±HH` (two-digit hours without a range limit, matching the prime-time
 * bound suffixes; minutes `00`-`59`).
 */
const OFFSET_PATTERN = /^[+-](\d{2})(?::?([0-5]\d))?$/

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let instance = formatters.get(timeZone)
  if (!instance) {
    instance = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    formatters.set(timeZone, instance)
  }
  return instance
}

function fixedOffsetMinutes(value: string): number | undefined {
  const match = OFFSET_PATTERN.exec(value)
  if (!match) return undefined
  const minutes = Number(match[1]) * 60 + Number(match[2] ?? "0")
  return value[0] === "-" ? -minutes : minutes
}

function wallClockParts(epochMs: number, timeZone: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const part of formatter(timeZone).formatToParts(new Date(epochMs))) result[part.type] = part.value
  return result
}

/**
 * Reports whether `value` is a usable zone designator: an IANA zone name known
 * to the runtime's ICU, or an explicit `±HH:MM`/`±HHMM`/`±HH` offset. Used by
 * the provider config schema to reject malformed `options.timezone` values at
 * config load.
 */
export function isZone(value: string): boolean {
  if (OFFSET_PATTERN.test(value)) return true
  try {
    formatter(value)
    return true
  } catch {
    return false
  }
}

/**
 * Offset of `timeZone` in minutes east of UTC at instant `epochMs`.
 *
 * `timeZone` is either an explicit offset string (returned as parsed minutes,
 * instant-independent) or an IANA zone name resolved through ICU, which
 * accounts for the zone's DST rules at that instant.
 */
export function offsetMinutes(epochMs: number, timeZone: string): number {
  const fixed = fixedOffsetMinutes(timeZone)
  if (fixed !== undefined) return fixed
  const clock = wallClockParts(epochMs, timeZone)
  const asUTC = Date.UTC(
    Number(clock.year),
    Number(clock.month) - 1,
    Number(clock.day),
    Number(clock.hour),
    Number(clock.minute),
    Number(clock.second),
  )
  return Math.round((asUTC - epochMs) / 60000)
}

export interface WallClock {
  /** Weekday of the wall clock, 0 = Sunday through 6 = Saturday (Date#getDay). */
  weekday: number
  /** Seconds elapsed since the wall-clock midnight, in `[0, 86400)`. */
  secondsOfDay: number
}

/**
 * Wall-clock weekday and seconds-of-day of instant `epochMs` in `timeZone`
 * (explicit offset string or IANA zone name).
 */
export function wallClock(epochMs: number, timeZone: string): WallClock {
  const clock = wallClockParts(epochMs, timeZone)
  return {
    weekday: WEEKDAY_INDEX[clock.weekday.toLowerCase()] ?? 0,
    secondsOfDay:
      Number(clock.hour) * 3600 + Number(clock.minute) * 60 + Number(clock.second),
  }
}

/**
 * Epoch milliseconds for naive wall-clock `components` interpreted in
 * `timeZone` (explicit offset string or IANA zone name).
 *
 * For IANA zones the offset is resolved twice — first at the naive instant
 * read as UTC, then at the corrected instant — so DST-transition days convert
 * the wall clock with the offset in effect at the resulting moment. Near a
 * spring-forward gap the wall clock resolves to the instant the zone's rules
 * select for that local time.
 */
export function toEpoch(
  components: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timeZone: string,
): number {
  const naive = Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute,
    components.second ?? 0,
  )
  const fixed = fixedOffsetMinutes(timeZone)
  if (fixed !== undefined) return naive - fixed * 60_000
  const first = naive - offsetMinutes(naive, timeZone) * 60_000
  return naive - offsetMinutes(first, timeZone) * 60_000
}
