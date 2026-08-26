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
      description: "ISO 8601 local time (HH:MM:SS) marking the start of the model's prime-time window",
    }),
  ),
  primeTimeEnd: Schema.optional(
    Schema.String.annotate({
      description: "ISO 8601 local time (HH:MM:SS) marking the end of the model's prime-time window",
    }),
  ),
  primeTimeDay: Schema.optional(
    Schema.mutable(Schema.Array(PrimeTimeDay)).annotate({
      description: "Weekdays the prime-time window applies to (day of the current moment)",
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

const secondsOfDay = (value: string) => {
  const [hours = 0, minutes = 0, seconds = 0] = value.split(":").map(Number)
  return hours * 3600 + minutes * 60 + seconds
}

/**
 * Reports whether `now` falls inside the configured prime-time window.
 *
 * Used to block provider requests while a model is in prime-time. The window is
 * active only when all three fields are present and `primeTimeDay` is non-empty;
 * otherwise the model is never blocked.
 *
 * Contract:
 * - `primeTimeStart`/`primeTimeEnd` are ISO 8601 local times ("HH:MM[:SS]"); a
 *   missing seconds component is treated as 0. Invalid input never blocks (the
 *   comparison degrades to NaN, which no interval contains).
 * - The weekday is the day of the current moment: a 22:00–06:00 window blocks on
 *   a given day only if that day is listed, so a window crossing midnight needs
 *   both days listed to cover the whole span.
 * - When `start <= end` the window is that single day interval (inclusive
 *   bounds). When `start > end` the window crosses midnight and is active from
 *   `start` until midnight or from midnight until `end`.
 */
export function primeTimeActive(window: PrimeTimeWindow, now: Date = new Date()): boolean {
  const start = window.primeTimeStart
  const end = window.primeTimeEnd
  const days = window.primeTimeDay
  if (start === undefined || end === undefined || days === undefined || days.length === 0) return false
  if (!days.includes(WEEKDAYS[now.getDay()])) return false

  const current = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
  const from = secondsOfDay(start)
  const to = secondsOfDay(end)
  return from <= to ? current >= from && current <= to : current >= from || current <= to
}
