export * as ConfigProviderV1 from "./provider"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const ModelStatus = Schema.Literals(["alpha", "beta", "deprecated", "active"])

const InterleavedField = Schema.Union([
  Schema.Literals(["reasoning", "reasoning_content", "reasoning_text"]),
  Schema.String,
])

export const PrimeTimeDay = Schema.Literals(["sun", "mon", "tue", "wed", "thu", "fri", "sat"])

export const Model = Schema.Struct({
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
        "ISO 8601 time-of-day (HH:MM[:SS], optionally suffixed with Z or a ±HH:MM/±HHmm/±HH offset; no suffix means process-local time) marking the start of the model's prime-time window",
    }),
  ),
  primeTimeEnd: Schema.optional(
    Schema.String.annotate({
      description:
        "ISO 8601 time-of-day (HH:MM[:SS], optionally suffixed with Z or a ±HH:MM/±HHmm/±HH offset; no suffix means process-local time) marking the end of the model's prime-time window",
    }),
  ),
  primeTimeDay: Schema.optional(
    Schema.mutable(Schema.Array(PrimeTimeDay)).annotate({
      description: "Weekdays the prime-time window applies to (process-local weekday of the current moment)",
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
 * Strict ISO 8601 time-of-day pattern with an optional explicit offset.
 *
 * Captures: hours, minutes, optional seconds, and an optional zone designator
 * (`Z`, `±HH:MM`, `±HHmm`, or `±HH`). Two-digit components only; anything else
 * (including `Z` followed by an offset) must not match so callers fail open.
 */
const ISO_TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2}|[+-]\d{2})?$/

/**
 * Parses an ISO 8601 time-of-day string into seconds-of-day on the UTC circle,
 * normalized to `[0, 86400)`.
 *
 * Used to place prime-time window bounds on a single comparison scale:
 * - `"HH:MM[:SS]"` — local time, converted via the process timezone offset in
 *   effect at `now`.
 * - `"HH:MM[:SS]Z"` — UTC.
 * - `"HH:MM[:SS]±HH:MM"` / `"HH:MM[:SS]±HHmm"` / `"HH:MM[:SS]±HH"` — fixed
 *   offset east of UTC for `+`, west for `-`.
 *
 * Returns `null` for anything malformed: non two-digit components, hours > 23,
 * minutes/seconds > 59, or offset minutes > 59. Callers treat `null` as "no
 * window" (fail-open) so garbage never blocks a model.
 */
function parseTimeOfDayUtc(value: string, now: Date): number | null {
  const match = ISO_TIME_PATTERN.exec(value)
  if (match === null) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3] ?? "0")
  if (hours > 23 || minutes > 59 || seconds > 59) return null

  let secondsOfDay = hours * 3600 + minutes * 60 + seconds
  const zone = match[4]
  if (zone === undefined) secondsOfDay += now.getTimezoneOffset() * 60
  else if (zone !== "Z") {
    const digits = zone.slice(1).replace(":", "")
    const offsetHours = Number(digits.slice(0, 2))
    const offsetMinutes = Number(digits.slice(2).padEnd(2, "0"))
    if (offsetMinutes > 59) return null
    secondsOfDay -= (zone[0] === "+" ? 1 : -1) * (offsetHours * 3600 + offsetMinutes * 60)
  }
  return ((secondsOfDay % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY
}

/**
 * Reports whether `now` falls inside the configured prime-time window.
 *
 * Used to block provider requests while a model is in prime-time. The window is
 * active only when all three fields are present and `primeTimeDay` is non-empty;
 * otherwise the model is never blocked.
 *
 * Contract:
 * - `primeTimeStart`/`primeTimeEnd` are ISO 8601 time-of-day strings: "HH:MM[:SS]"
 *   (process-local time), "HH:MM[:SS]Z" (UTC), or "HH:MM[:SS]±HH:MM"/"±HHmm"/"±HH"
 *   (fixed offset). Missing seconds default to 0. Any malformed bound (including
 *   out-of-range components) disables the window entirely (fail-open).
 * - All bounds and `now` are compared on one scale: seconds-of-day on the UTC
 *   circle `[0, 86400)`. Offset-less bounds are rotated into that frame using the
 *   process timezone offset in effect at `now`, so local and explicit-offset
 *   bounds compose in a single frame.
 * - The weekday is the local day of the current moment: a 22:00–06:00 window
 *   blocks on a given day only if that day is listed, so a window crossing
 *   midnight needs both days listed to cover the whole span.
 * - When `start <= end` (after normalization) the window is that single interval
 *   on the UTC circle (inclusive bounds). When `start > end` the window crosses
 *   midnight and is active from `start` until midnight or from midnight until `end`.
 */
export function primeTimeActive(window: PrimeTimeWindow, now: Date = new Date()): boolean {
  const start = window.primeTimeStart
  const end = window.primeTimeEnd
  const days = window.primeTimeDay
  if (start === undefined || end === undefined || days === undefined || days.length === 0) return false
  if (!days.includes(WEEKDAYS[now.getDay()])) return false

  const from = parseTimeOfDayUtc(start, now)
  const to = parseTimeOfDayUtc(end, now)
  if (from === null || to === null) return false

  const current = Math.floor(now.getTime() / 1000) % SECONDS_PER_DAY
  return from <= to ? current >= from && current <= to : current >= from || current <= to
}
