export * as ConfigProviderV1 from "./provider"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const ModelStatus = Schema.Literals(["alpha", "beta", "deprecated", "active"])

const InterleavedField = Schema.Union([
  Schema.Literals(["reasoning", "reasoning_content", "reasoning_text"]),
  Schema.String,
])

export const PrimeTimeDay = Schema.Literals(["sun", "mon", "tue", "wed", "thu", "fri", "sat"])

/**
 * Strict ISO 8601 time-of-day pattern with an optional explicit offset.
 *
 * Captures: hours (`00`-`23`), minutes (`00`-`59`), optional seconds
 * (`00`-`59`), and an optional zone designator (`Z`, `±HH:MM`, `±HHmm`, or
 * `±HH`; offset minutes `00`-`59`, offset hours two digits without a range
 * limit). Anything else must not match so schema validation rejects it at
 * config load.
 */
const ISO_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(Z|[+-]\d{2}(?::?[0-5]\d)?)?$/

/**
 * Schema filter enforcing the strict prime-time bound format per field, so
 * malformed values fail config load instead of silently disabling the window.
 *
 * The attached arbitrary candidate generates well-formed bounds for
 * `Schema.toArbitrary` (property-based config tests); without it the base
 * string generator almost never satisfies the pattern and rejection sampling
 * diverges.
 */
const isIsoTimeOfDay = Schema.makeFilter<string>(
  (value) =>
    ISO_TIME_PATTERN.test(value)
      ? undefined
      : `Invalid prime-time bound '${value}': expected HH:MM[:SS] with an optional Z or ±HH:MM/±HHmm/±HH offset`,
  {
    arbitrary: {
      candidate: {
        make: (fc) => {
          const two = (n: number) => String(n).padStart(2, "0")
          const zones = ["Z", "+03:00", "-05:00", "+0530", "+07"]
          return fc
            .tuple(
              fc.integer({ min: 0, max: 23 }),
              fc.integer({ min: 0, max: 59 }),
              fc.integer({ min: 0, max: 59 }),
              fc.integer({ min: 0, max: zones.length }),
            )
            .map(([hours, minutes, seconds, zone]) => {
              const base = `${two(hours)}:${two(minutes)}:${two(seconds)}`
              return zone < zones.length ? base + zones[zone] : base
            })
        },
      },
    },
  },
)

const modelFields = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  family: Schema.optional(Schema.String),
  release_date: Schema.optional(Schema.String),
  attachment: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(Schema.Boolean),
  temperature: Schema.optional(Schema.Boolean),
  tool_call: Schema.optional(Schema.Boolean),
  primeTimeStart: Schema.optional(
    Schema.String.annotate({
      description:
        "ISO 8601 time-of-day (HH:MM[:SS], optionally suffixed with Z or a ±HH:MM/±HHmm/±HH offset) marking the start of the model's prime-time window; start and end must both carry the same offset suffix or both omit it",
    }).check(isIsoTimeOfDay),
  ),
  primeTimeEnd: Schema.optional(
    Schema.String.annotate({
      description:
        "ISO 8601 time-of-day (HH:MM[:SS], optionally suffixed with Z or a ±HH:MM/±HHmm/±HH offset) marking the end of the model's prime-time window; start and end must both carry the same offset suffix or both omit it",
    }).check(isIsoTimeOfDay),
  ),
  primeTimeDay: Schema.optional(
    Schema.mutable(Schema.Array(PrimeTimeDay)).annotate({
      description: "Weekdays the prime-time window applies to (weekday of the current moment in the window's timezone)",
    }),
  ),
  primeTimeRetry: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "When true, an active prime-time window fails retryably with the retry scheduled at the window end instead of standard backoff; absent or false keeps the terminal error",
    }),
  ),
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      InterleavedField,
      Schema.Struct({
        field: InterleavedField,
      }),
    ]),
  ),
  cost: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
      context_over_200k: Schema.optional(
        Schema.Struct({
          input: Schema.Finite,
          output: Schema.Finite,
          cache_read: Schema.optional(Schema.Finite),
          cache_write: Schema.optional(Schema.Finite),
        }),
      ),
    }),
  ),
  limit: Schema.optional(
    Schema.Struct({
      context: Schema.Finite,
      input: Schema.optional(Schema.Finite),
      output: Schema.Finite,
    }),
  ),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])))),
      output: Schema.optional(
        Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"]))),
      ),
    }),
  ),
  experimental: Schema.optional(Schema.Boolean),
  status: Schema.optional(ModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  variants: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.StructWithRest(
        Schema.Struct({
          disabled: Schema.optional(Schema.Boolean).annotate({ description: "Disable this variant for the model" }),
        }),
        [Schema.Record(Schema.String, Schema.Any)],
      ),
    ).annotate({ description: "Variant-specific configuration" }),
  ),
})

/**
 * Cross-field prime-time zone-consistency check: `primeTimeStart` and
 * `primeTimeEnd` must both carry a zone suffix with the same effective offset
 * (`Z` equals `+00:00`; `+03` equals `+03:00` and `+0300`), or both omit the
 * suffix, so the window has exactly one timezone. Violations fail config load
 * with a schema decode error.
 */
const primeTimeZonesConsistent = Schema.makeFilter<Schema.Schema.Type<typeof modelFields>>((model) => {
  const zone = (value: string | undefined) =>
    value === undefined ? undefined : (parseTimeOfDay(value)?.offsetMinutes ?? null)
  const start = zone(model.primeTimeStart)
  const end = zone(model.primeTimeEnd)
  if (start === undefined || end === undefined) return undefined
  if (start === null && end === null) return undefined
  if (start === null || end === null)
    return "primeTimeStart and primeTimeEnd must both carry a zone suffix (Z, ±HH:MM, ±HHmm, or ±HH) or both omit it"
  if (start !== end)
    return `primeTimeStart (${model.primeTimeStart}) and primeTimeEnd (${model.primeTimeEnd}) must use the same timezone offset`
  return undefined
})

export const Model = modelFields.check(primeTimeZonesConsistent)

export const Info = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  env: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  id: Schema.optional(Schema.String),
  npm: Schema.optional(Schema.String),
  whitelist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  blacklist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  options: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        apiKey: Schema.optional(Schema.String),
        baseURL: Schema.optional(Schema.String),
        enterpriseUrl: Schema.optional(Schema.String).annotate({
          description: "GitHub Enterprise URL for copilot authentication",
        }),
        setCacheKey: Schema.optional(Schema.Boolean).annotate({
          description: "Enable promptCacheKey for this provider (default false)",
        }),
        timeout: Schema.optional(
          Schema.Union([PositiveInt, Schema.Literal(false)]).annotate({
            description: "Timeout in milliseconds for full requests to this provider. Set to false to disable timeout.",
          }),
        ).annotate({
          description: "Timeout in milliseconds for full requests to this provider. Set to false to disable timeout.",
        }),
        headerTimeout: Schema.optional(
          Schema.Union([PositiveInt, Schema.Literal(false)]).annotate({
            description:
              "Timeout in milliseconds to wait for response headers (default: 300000). Set to false to disable timeout.",
          }),
        ).annotate({
          description:
            "Timeout in milliseconds to wait for response headers (default: 300000). Set to false to disable timeout.",
        }),
        chunkTimeout: Schema.optional(
          Schema.Union([PositiveInt, Schema.Literal(false)]).annotate({
            description:
              "Timeout in milliseconds between streamed SSE chunks for this provider (default: 300000). If no chunk arrives within this window, the request is aborted. Set to false to disable timeout.",
          }),
        ).annotate({
          description:
            "Timeout in milliseconds between streamed SSE chunks for this provider (default: 300000). If no chunk arrives within this window, the request is aborted. Set to false to disable timeout.",
        }),
        retries: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000000 }))).annotate({
          description:
            "Maximum number of retry attempts for failed LLM requests to this provider (0-1000000; 0 disables retries). Defaults to 5 when unset. Counted per request: 1 initial attempt plus up to this many retries.",
        }),
      }),
      [Schema.Record(Schema.String, Schema.Any)],
    ),
  ),
  models: Schema.optional(Schema.Record(Schema.String, Model)),
}).annotate({ identifier: "ProviderConfig" })
export type Info = Schema.Schema.Type<typeof Info>

export interface PrimeTimeWindow {
  readonly primeTimeStart?: string
  readonly primeTimeEnd?: string
  readonly primeTimeDay?: ReadonlyArray<string>
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const

const SECONDS_PER_DAY = 86400

/**
 * One parsed prime-time bound: wall-clock seconds-of-day in `[0, 86400)` and
 * the explicit zone offset in minutes east of UTC, or `null` when the bound
 * has no suffix (process-local).
 */
interface PrimeTimeBound {
  readonly secondsOfDay: number
  readonly offsetMinutes: number | null
}

/**
 * Parses an ISO 8601 time-of-day string into wall-clock seconds-of-day plus
 * its zone designator. Component ranges are enforced by `ISO_TIME_PATTERN`.
 *
 * Returns `null` for anything malformed. The V1 config schema rejects such
 * values at load time; callers treat `null` as "no window" only as a backstop
 * for values that bypass the schema.
 */
function parseTimeOfDay(value: string): PrimeTimeBound | null {
  const match = ISO_TIME_PATTERN.exec(value)
  if (match === null) return null
  const secondsOfDay = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? "0")
  const zone = match[4]
  if (zone === undefined) return { secondsOfDay, offsetMinutes: null }
  if (zone === "Z") return { secondsOfDay, offsetMinutes: 0 }
  const digits = zone.slice(1).replace(":", "")
  const totalMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2).padEnd(2, "0"))
  return { secondsOfDay, offsetMinutes: (zone[0] === "+" ? 1 : -1) * totalMinutes }
}

/**
 * Reports whether `now` falls inside the configured prime-time window,
 * evaluated in the window's timezone.
 *
 * Used to block provider requests while a model is in prime-time. The window is
 * active only when all three fields are present and `primeTimeDay` is non-empty;
 * otherwise the model is never blocked.
 *
 * Contract:
 * - `primeTimeStart`/`primeTimeEnd` are ISO 8601 time-of-day strings "HH:MM[:SS]"
 *   with an optional zone suffix `Z`, `±HH:MM`, `±HHmm`, or `±HH`. The V1 config
 *   schema rejects malformed bounds and zone-inconsistent pairs at load time;
 *   this predicate additionally treats them as "no window" (fail-open backstop
 *   for values that bypass the schema).
 * - The window timezone is the shared explicit offset of both bounds, or the
 *   process timezone when neither bound has a suffix. Both the weekday and the
 *   seconds-of-day of `now` are computed in that timezone: the instant is
 *   shifted by the explicit offset (or read through the process timezone)
 *   before deriving weekday and wall-clock time.
 * - The window matches when the window-timezone weekday of `now` is listed in
 *   `primeTimeDay` and the window-timezone seconds-of-day lies inside the
 *   bounds, both ends inclusive. When `start <= end` the window is that single
 *   interval; when `start > end` it crosses midnight and is active from
 *   `start` until day end or from day start until `end`, so a full overnight
 *   span such as 22:00–06:00 needs both weekdays listed (in the window
 *   timezone).
 */
export function primeTimeActive(window: PrimeTimeWindow, now: Date = new Date()): boolean {
  const start = window.primeTimeStart
  const end = window.primeTimeEnd
  const days = window.primeTimeDay
  if (start === undefined || end === undefined || days === undefined || days.length === 0) return false

  const from = parseTimeOfDay(start)
  const to = parseTimeOfDay(end)
  if (from === null || to === null || from.offsetMinutes !== to.offsetMinutes) return false

  // Weekday and wall-clock time of `now` in the window's timezone: an explicit
  // offset shifts the instant; a suffix-less window uses the process timezone.
  const epochSeconds = Math.floor(now.getTime() / 1000)
  const offsetSeconds = from.offsetMinutes === null ? -now.getTimezoneOffset() * 60 : from.offsetMinutes * 60
  const weekday =
    from.offsetMinutes === null ? now.getDay() : new Date((epochSeconds + from.offsetMinutes * 60) * 1000).getUTCDay()
  if (!days.includes(WEEKDAYS[weekday])) return false

  const secondsOfDay = (((epochSeconds + offsetSeconds) % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY
  return from.secondsOfDay <= to.secondsOfDay
    ? secondsOfDay >= from.secondsOfDay && secondsOfDay <= to.secondsOfDay
    : secondsOfDay >= from.secondsOfDay || secondsOfDay <= to.secondsOfDay
}

/**
 * Returns the epoch-millisecond instant of the configured window's end: the
 * first instant at which `primeTimeActive` no longer matches, or `undefined`
 * when the window is inactive, unconfigured, malformed, or never ends (a span
 * covering every second of listed days, such as 00:00:00–23:59:59 on all
 * weekdays).
 *
 * Used to schedule a prime-time-blocked retry for `primeTimeRetry` models: the
 * delay is the time remaining until this instant.
 */
export function primeTimeWindowEnd(window: PrimeTimeWindow, now: Date = new Date()): number | undefined {
  const start = window.primeTimeStart
  const end = window.primeTimeEnd
  const days = window.primeTimeDay
  if (start === undefined || end === undefined || days === undefined || days.length === 0) return undefined
  const from = parseTimeOfDay(start)
  const to = parseTimeOfDay(end)
  if (from === null || to === null || from.offsetMinutes !== to.offsetMinutes) return undefined
  if (!primeTimeActive(window, now)) return undefined

  // Epoch second at which the active span containing `instant` ends, computed
  // in the window's timezone with the same offset rules as `primeTimeActive`.
  // The end bound still matches (inclusive), so the first non-matching second
  // is one past it.
  const spanEndSeconds = (instant: Date): number => {
    const offsetSeconds = from.offsetMinutes === null ? -instant.getTimezoneOffset() * 60 : from.offsetMinutes * 60
    const localSeconds = Math.floor(instant.getTime() / 1000) + offsetSeconds
    const localDay = Math.floor(localSeconds / SECONDS_PER_DAY)
    const localSecondsOfDay = localSeconds - localDay * SECONDS_PER_DAY
    // A same-day span, or the morning half of an overnight span, ends one
    // second past the end bound on the current local day.
    if (from.secondsOfDay <= to.secondsOfDay || localSecondsOfDay <= to.secondsOfDay)
      return localDay * SECONDS_PER_DAY + to.secondsOfDay + 1 - offsetSeconds
    // Evening half of an overnight span: it runs through midnight and only
    // continues when the next local weekday is listed; otherwise it ends at
    // that midnight.
    const nextDay = localDay + 1
    return days.includes(WEEKDAYS[(nextDay + 4) % 7])
      ? nextDay * SECONDS_PER_DAY + to.secondsOfDay + 1 - offsetSeconds
      : nextDay * SECONDS_PER_DAY - offsetSeconds
  }

  // Verify the computed boundary against the predicate itself and step forward
  // while it is still active: a window covering (almost) the whole day continues
  // into the next listed weekday's span, and a process-local window crossing a
  // DST transition shifts the boundary. Each step advances at least a full day
  // and the weekday cycle repeats weekly, so a window still active after eight
  // steps never ends.
  let target = spanEndSeconds(now)
  for (let index = 0; index < 8; index++) {
    if (!primeTimeActive(window, new Date(target * 1000))) return target * 1000
    target = spanEndSeconds(new Date(target * 1000))
  }
  return undefined
}
