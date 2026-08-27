import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { ConfigProviderPlugin } from "@opencode-ai/core/config/plugin/provider"
import { Integration } from "@opencode-ai/core/integration"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { primeTimeActive } from "@opencode-ai/core/v1/config/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* (config: Config.Interface) {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provideService(Config.Service, config))
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )
}

function request(headers: Record<string, string>, variant?: string) {
  return {
    headers,
    variant,
  }
}

const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigProviderPlugin.Plugin", () => {
  it.effect("keeps configured model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.opencode
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  opencode: {
                    api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://opencode.test/v1" },
                    models: {
                      "alpha-gpt-next": {
                        variants: [
                          {
                            id: "high",
                            body: {
                              reasoningEffort: "high",
                              reasoningSummary: "auto",
                              include: ["reasoning.encrypted_content"],
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants).toMatchObject([
        {
          id: "high",
          body: {
            reasoningEffort: "high",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        },
      ])
    }),
  )

  it.effect("keeps layered model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.opencode
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  opencode: {
                    api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://opencode.test/v1" },
                  },
                },
              }),
            }),
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  opencode: {
                    models: {
                      "alpha-gpt-next": {
                        variants: [{ id: "high", body: { reasoningEffort: "high" } }],
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants[0]).toMatchObject({
        id: "high",
        body: { reasoningEffort: "high" },
      })
    }),
  )

  it.effect("loads configured providers and applies later model overrides", () =>
    withEnv({ CUSTOM_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const integrations = yield* Integration.Service
        const providerID = ProviderV2.ID.make("custom")
        const modelID = ModelV2.ID.make("chat")
        const config = Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: decode({
                  model: "custom/first",
                  providers: {
                    custom: {
                      name: "Configured",
                      env: ["CUSTOM_API_KEY"],
                      api: { type: "native", settings: {} },
                      request: request({ first: "first", shared: "first" }),
                      models: {
                        chat: {
                          name: "First",
                          capabilities: { tools: true, input: ["text"], output: ["text"] },
                          disabled: true,
                          limit: { context: 100, output: 50 },
                          cost: { input: 1, output: 2 },
                          request: request({ first: "first", shared: "first" }, "retained"),
                          variants: [
                            {
                              id: "fast",
                              headers: { first: "first", shared: "first" },
                            },
                          ],
                        },
                      },
                    },
                  },
                }),
              }),
              new Config.Document({
                type: "document",
                info: decode({
                  model: "custom/default",
                  providers: {
                    custom: {
                      api: { type: "aisdk", package: "custom-sdk", url: "https://example.test" },
                      request: request({ last: "last", shared: "last" }),
                      models: {
                        default: {
                          name: "Default",
                        },
                        chat: {
                          api: { id: "api-chat" },
                          name: "Last",
                          limit: { output: 75 },
                          request: request({ last: "last", shared: "last" }),
                          variants: [
                            {
                              id: "fast",
                              headers: { last: "last", shared: "last" },
                            },
                            {
                              id: "slow",
                              headers: { slow: "slow" },
                            },
                          ],
                        },
                      },
                    },
                  },
                }),
              }),
              new Config.Document({
                type: "document",
                info: decode({
                  providers: {
                    custom: { name: "Renamed" },
                  },
                }),
              }),
            ]),
        })

        yield* addPlugin(config)

        const provider = required(yield* catalog.provider.get(providerID))
        const model = required(yield* catalog.model.get(providerID, modelID))
        expect((yield* catalog.model.default())?.id).toBe(ModelV2.ID.make("default"))
        expect(provider.name).toBe("Renamed")
        expect((yield* integrations.get(Integration.ID.make("custom")))?.methods).toContainEqual({
          type: "env",
          names: ["CUSTOM_API_KEY"],
        })
        expect((yield* integrations.get(Integration.ID.make("custom")))?.name).toBe("Renamed")
        expect(provider.disabled).toBeUndefined()
        expect(provider.api).toEqual({ type: "aisdk", package: "custom-sdk", url: "https://example.test" })
        expect(provider.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.api.id).toBe(ModelV2.ID.make("api-chat"))
        expect(model.name).toBe("Last")
        expect(model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
        expect(model.enabled).toBe(false)
        expect(model.limit).toEqual({ context: 100, output: 75 })
        expect(model.cost).toEqual([{ input: 1, output: 2, cache: { read: 0, write: 0 }, tier: undefined }])
        expect(model.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.request.variant).toBe("retained")
        expect(model.variants.map((variant) => variant.id)).toEqual([
          ModelV2.VariantID.make("fast"),
          ModelV2.VariantID.make("slow"),
        ])
        expect(model.variants[0]?.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.variants[1]?.headers).toEqual({ slow: "slow" })
      }),
    ),
  )
})

describe("primeTimeActive", () => {
  // 2026-08-24 is a Monday. Every instant is a fixed UTC epoch; the process
  // timezone is pinned per case so offset-less (local) bounds are deterministic.
  const ALL_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
  const prime = (start: string, end: string, days: ReadonlyArray<string>) =>
    ({ primeTimeStart: start, primeTimeEnd: end, primeTimeDay: days }) as const
  // Monday at the given UTC wall time.
  const utc = (hours: number, minutes = 0, seconds = 0) => new Date(Date.UTC(2026, 7, 24, hours, minutes, seconds))

  describe("with local-time bounds", () => {
    // Europe/Moscow is UTC+3 year-round (no DST), so local wall time = UTC + 3h.
    const local = (hours: number, minutes = 0, seconds = 0) => utc(hours - 3, minutes, seconds)

    it.effect("blocks inside a same-day window", () =>
      withEnv({ TZ: "Europe/Moscow" }, () =>
        Effect.sync(() => {
          expect(primeTimeActive(prime("09:00:00", "18:00:00", ["mon"]), local(12))).toBe(true)
        }),
      ),
    )

    it.effect("passes outside a same-day window", () =>
      withEnv({ TZ: "Europe/Moscow" }, () =>
        Effect.sync(() => {
          expect(primeTimeActive(prime("09:00:00", "18:00:00", ["mon"]), local(20))).toBe(false)
        }),
      ),
    )

    it.effect("treats window edges as inclusive", () =>
      withEnv({ TZ: "Europe/Moscow" }, () =>
        Effect.sync(() => {
          expect(primeTimeActive(prime("09:00:00", "18:00:00", ["mon"]), local(9))).toBe(true)
          expect(primeTimeActive(prime("09:00:00", "18:00:00", ["mon"]), local(18))).toBe(true)
        }),
      ),
    )

    it.effect("blocks both sides of a cross-midnight window when both days are listed", () =>
      withEnv({ TZ: "Europe/Moscow" }, () =>
        Effect.sync(() => {
          const window = prime("22:00:00", "06:00:00", ["mon", "tue"])
          expect(primeTimeActive(window, local(23))).toBe(true)
          // Tuesday 05:00 local is still inside the Monday-listed evening span's window.
          expect(primeTimeActive(window, new Date(Date.UTC(2026, 7, 25, 2)))).toBe(true)
        }),
      ),
    )

    it.effect("passes before a cross-midnight window starts", () =>
      withEnv({ TZ: "Europe/Moscow" }, () =>
        Effect.sync(() => {
          expect(primeTimeActive(prime("22:00:00", "06:00:00", ["mon"]), local(21))).toBe(false)
        }),
      ),
    )

    it.effect("passes when the current weekday is not configured", () =>
      withEnv({ TZ: "Europe/Moscow" }, () =>
        Effect.sync(() => {
          expect(primeTimeActive(prime("09:00:00", "18:00:00", ["tue"]), local(12))).toBe(false)
        }),
      ),
    )

    it.effect("supports bounds without seconds", () =>
      withEnv({ TZ: "Europe/Moscow" }, () =>
        Effect.sync(() => {
          expect(primeTimeActive(prime("09:00", "18:00", ["mon"]), local(12))).toBe(true)
        }),
      ),
    )
  })

  describe("with explicit UTC offsets", () => {
    it.effect("blocks inside a same-day Z window", () =>
      withEnv({ TZ: "UTC" }, () =>
        Effect.sync(() => {
          expect(primeTimeActive(prime("09:00:00Z", "18:00:00Z", ["mon"]), utc(12))).toBe(true)
        }),
      ),
    )

    it.effect("passes outside a same-day Z window", () =>
      withEnv({ TZ: "UTC" }, () =>
        Effect.sync(() => {
          expect(primeTimeActive(prime("09:00:00Z", "18:00:00Z", ["mon"]), utc(20))).toBe(false)
        }),
      ),
    )

    it.effect("blocks a cross-midnight Z window on both sides but not at midday", () =>
      withEnv({ TZ: "UTC" }, () =>
        Effect.sync(() => {
          const window = prime("22:00:00Z", "06:00:00Z", ["mon", "tue"])
          expect(primeTimeActive(window, utc(23))).toBe(true)
          expect(primeTimeActive(window, new Date(Date.UTC(2026, 7, 25, 2)))).toBe(true)
          expect(primeTimeActive(window, utc(12))).toBe(false)
        }),
      ),
    )

    it.effect("honors positive ±HH:MM offsets", () =>
      withEnv({ TZ: "UTC" }, () =>
        Effect.sync(() => {
          // 12:00+05:30–20:00+05:30 is 06:30Z–14:30Z.
          const window = prime("12:00:00+05:30", "20:00:00+05:30", ["mon"])
          expect(primeTimeActive(window, utc(10))).toBe(true)
          expect(primeTimeActive(window, utc(16))).toBe(false)
        }),
      ),
    )

    it.effect("honors negative compact ±HHmm offsets", () =>
      withEnv({ TZ: "UTC" }, () =>
        Effect.sync(() => {
          // 09:00-0500–17:00-0500 is 14:00Z–22:00Z; bounds without seconds default to :00.
          const window = prime("09:00-0500", "17:00-0500", ["mon"])
          expect(primeTimeActive(window, utc(15))).toBe(true)
          expect(primeTimeActive(window, utc(12))).toBe(false)
        }),
      ),
    )

    it.effect("honors positive compact ±HHmm offsets", () =>
      withEnv({ TZ: "UTC" }, () =>
        Effect.sync(() => {
          // 10:30+0530–18:30+0530 is 05:00Z–13:00Z.
          const window = prime("10:30+0530", "18:30+0530", ["mon"])
          expect(primeTimeActive(window, utc(9))).toBe(true)
          expect(primeTimeActive(window, utc(4))).toBe(false)
          expect(primeTimeActive(window, utc(14))).toBe(false)
        }),
      ),
    )

    it.effect("honors short ±HH offsets", () =>
      withEnv({ TZ: "UTC" }, () =>
        Effect.sync(() => {
          // 12:00+07–20:00+07 is 05:00Z–13:00Z; -07 mirrors it across midnight UTC.
          expect(primeTimeActive(prime("12:00+07", "20:00+07", ["mon"]), utc(10))).toBe(true)
          expect(primeTimeActive(prime("12:00+07", "20:00+07", ["mon"]), utc(15))).toBe(false)
          expect(primeTimeActive(prime("12:00-07", "20:00-07", ["mon"]), utc(22))).toBe(true)
        }),
      ),
    )

    it.effect("wraps cross-midnight windows declared in an explicit zone", () =>
      withEnv({ TZ: "UTC" }, () =>
        Effect.sync(() => {
          // 22:00+05:30–06:00+05:30 is 16:30Z–00:30Z, which wraps on the UTC circle.
          const window = prime("22:00:00+05:30", "06:00:00+05:30", ["mon", "tue"])
          expect(primeTimeActive(window, utc(23))).toBe(true)
          expect(primeTimeActive(window, utc(0, 15))).toBe(true)
          expect(primeTimeActive(window, utc(12))).toBe(false)
        }),
      ),
    )

    it.effect("normalizes bounds that rotate back across UTC midnight", () =>
      withEnv({ TZ: "UTC" }, () =>
        Effect.sync(() => {
          // 00:00+03:00–12:00+03:00 is 21:00Z–09:00Z: the start wraps to the previous UTC day.
          const window = prime("00:00:00+03:00", "12:00:00+03:00", ["mon", "tue"])
          expect(primeTimeActive(window, utc(22))).toBe(true)
          expect(primeTimeActive(window, utc(8))).toBe(true)
          expect(primeTimeActive(window, utc(10))).toBe(false)
          expect(primeTimeActive(window, utc(15))).toBe(false)
        }),
      ),
    )

    it.effect("evaluates offset windows in the window's timezone regardless of the process timezone", () =>
      withEnv({ TZ: "America/New_York" }, () =>
        Effect.sync(() => {
          // 12:00Z is 08:00 Monday in New York (UTC-4 in August).
          expect(primeTimeActive(prime("09:00:00Z", "18:00:00Z", ["mon"]), utc(12))).toBe(true)
          expect(primeTimeActive(prime("13:00:00Z", "20:00:00Z", ["mon"]), utc(12))).toBe(false)
        }),
      ),
    )
  })

  describe("weekday in the window's timezone", () => {
    it.effect("blocks when only the window-zone weekday is listed", () =>
      withEnv({ TZ: "Europe/Moscow" }, () =>
        Effect.sync(() => {
          // 2026-08-24 01:00 UTC: Monday 04:00 in Moscow (UTC+3), but Sunday
          // 20:00 in the UTC-05 window zone — inside 19:00–21:00 local to that zone.
          const now = new Date(Date.UTC(2026, 7, 24, 1))
          expect(primeTimeActive(prime("19:00:00-05:00", "21:00:00-05:00", ["sun"]), now)).toBe(true)
        }),
      ),
    )

    it.effect("passes when the process-local weekday is listed but the window-zone weekday is not", () =>
      withEnv({ TZ: "Europe/Moscow" }, () =>
        Effect.sync(() => {
          const now = new Date(Date.UTC(2026, 7, 24, 1))
          expect(primeTimeActive(prime("19:00:00-05:00", "21:00:00-05:00", ["mon"]), now)).toBe(false)
        }),
      ),
    )

    it.effect("evaluates a Z window's weekday in UTC regardless of the process timezone", () =>
      withEnv({ TZ: "America/New_York" }, () =>
        Effect.sync(() => {
          // 2026-08-25 02:00Z is Tuesday in UTC, still Monday evening in New York.
          const now = new Date(Date.UTC(2026, 7, 25, 2))
          expect(primeTimeActive(prime("01:00:00Z", "05:00:00Z", ["tue"]), now)).toBe(true)
          expect(primeTimeActive(prime("01:00:00Z", "05:00:00Z", ["mon"]), now)).toBe(false)
        }),
      ),
    )

    it.effect("keeps the process-local weekday for suffix-less windows", () =>
      withEnv({ TZ: "Europe/Moscow" }, () =>
        Effect.sync(() => {
          // Monday 04:00 local; the same instant is Sunday in UTC-05, but a
          // suffix-less window must keep the process-local weekday.
          const now = new Date(Date.UTC(2026, 7, 24, 1))
          expect(primeTimeActive(prime("00:00:00", "23:59:59", ["mon"]), now)).toBe(true)
          expect(primeTimeActive(prime("00:00:00", "23:59:59", ["sun"]), now)).toBe(false)
        }),
      ),
    )
  })

  describe("with zone-inconsistent bounds", () => {
    it.effect("treats mixed suffixes and differing offsets as an inactive window", () =>
      withEnv({ TZ: "UTC" }, () =>
        Effect.sync(() => {
          // Config load rejects these pairs; the predicate disables the window
          // when values bypass the schema.
          expect(primeTimeActive(prime("09:30", "12:00:00Z", ALL_DAYS), utc(11))).toBe(false)
          expect(primeTimeActive(prime("09:00+03:00", "18:00+05:00", ALL_DAYS), utc(12))).toBe(false)
        }),
      ),
    )
  })

  describe("with malformed bounds", () => {
    it.effect("treats garbage, out-of-range components, and bad offsets as an inactive window", () =>
      withEnv({ TZ: "UTC" }, () =>
        Effect.sync(() => {
          // Config load rejects these values; the predicate disables the window
          // when values bypass the schema.
          const now = utc(12)
          for (const start of [
            "9am",
            "",
            "25:00:00",
            "09:60:00",
            "09:00:60",
            "09:00:00+9:30",
            "09:00:00Z+01:00",
            "09:00:00+05:99",
          ]) {
            expect(primeTimeActive(prime(start, "18:00:00", ALL_DAYS), now)).toBe(false)
          }
          expect(primeTimeActive(prime("09:00:00", "garbage", ALL_DAYS), now)).toBe(false)
        }),
      ),
    )
  })
})
