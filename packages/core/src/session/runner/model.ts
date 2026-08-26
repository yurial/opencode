export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { type Model } from "@opencode-ai/llm"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@opencode-ai/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@opencode-ai/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@opencode-ai/llm/route"
import { Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { primeTimeActive } from "../../v1/config/provider"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export class ModelPrimeTimeError extends Schema.TaggedErrorClass<ModelPrimeTimeError>()(
  "SessionRunnerModel.ModelPrimeTimeError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {
  override get message() {
    return `Model ${this.providerID}/${this.modelID} is in prime-time and cannot be used.`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | ModelPrimeTimeError
  | Integration.AuthorizationError

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) => Layer.succeed(Service, Service.of({ resolve }))

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) => {
  const body = model.request.body
  const httpBody = Object.hasOwn(body, "apiKey")
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey"))
    : body
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    http: { body: httpBody },
    limits: { context: model.limit.context, output: model.limit.output },
  })
}

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          Object.assign(draft.request.headers, variant.headers)
          Object.assign(draft.request.body, variant.body)
        })
      : model,
  )
}

/**
 * Enforces a model's prime-time window: an optional configuration on catalog models that
 * names weekdays and a daily time range during which the model must not be used.
 *
 * Contract:
 * - Prime-time is disabled unless `primeTimeStart`, `primeTimeEnd`, and a non-empty
 *   `primeTimeDay` are all present; a disabled configuration passes the model through
 *   unchanged (same reference).
 * - `now` defaults to the current wall clock; inject a fixed instant for deterministic
 *   checks (tests, batch tooling). All comparisons use the local timezone of `now`.
 * - Day matching uses the weekday of `now` itself, so a 22:00-06:00 window needs both
 *   sides of midnight listed in `primeTimeDay` to cover a full overnight span.
 * - `primeTimeStart`/`primeTimeEnd` are "HH:MM:SS" strings. When the end is not after
 *   the start the window crosses midnight and matches the evening side of the start day
 *   and the early-morning side of the end. Edges are inclusive on both sides.
 * - Malformed time strings compare as absent and fail open (see TODO.md for the pending
 *   validation decision).
 * - A violation fails with `ModelPrimeTimeError`; otherwise the model passes through.
 */
export const checkPrimeTime = (model: ModelV2.Info, now: Date = new Date()): Effect.Effect<
  ModelV2.Info,
  ModelPrimeTimeError
> => {
  if (!primeTimeActive(model, now)) return Effect.succeed(model)
  return Effect.fail(new ModelPrimeTimeError({ providerID: model.providerID, modelID: model.id }))
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, UnsupportedApiError> => {
  const resolved =
    credential?.type !== "key" || credential.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        })
  const key = apiKey(resolved, credential)
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai") {
    return Effect.succeed(
      withDefaults(resolved, OpenAIResponses.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/anthropic") {
    return Effect.succeed(
      withDefaults(resolved, AnthropicMessages.route)
        .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai-compatible" && resolved.api.url) {
    return Effect.succeed(
      withDefaults(resolved, OpenAICompatibleChat.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: resolved.providerID,
      modelID: resolved.id,
      api: apiName(resolved),
    }),
  )
}

export const supported = (model: ModelV2.Info) =>
  model.api.type === "aisdk" &&
  (model.api.package === "@ai-sdk/openai" ||
    model.api.package === "@ai-sdk/anthropic" ||
    (model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined))

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        const defaultModel = session.model ? undefined : yield* catalog.model.default()
        const selected = session.model
          ? (yield* catalog.model.available()).find(
              (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
            )
          : defaultModel && supported(defaultModel)
            ? defaultModel
            : (yield* catalog.model.available()).find(supported)
        if (!selected && session.model)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })

        // Prime-time is a hard config restriction: fail before any provider or credential work.
        yield* checkPrimeTime(selected)

        const provider = yield* catalog.provider.get(selected.providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        )
        const credential = connection ? yield* integrations.connection.resolve(connection) : undefined
        return yield* withVariant(selected, session.model?.variant).pipe(
          Effect.flatMap((model) => fromCatalogModel(model, credential)),
        )
      }),
    })
  }),
)

/**
 * Test-only seam that mirrors the production `locationLayer` resolve pipeline for a
 * single catalog model: enforces prime-time, applies the session variant overlay, and
 * maps the catalog model into its native LLM route, in production precedence order.
 *
 * Contract:
 * - A model inside its prime-time window fails with `ModelPrimeTimeError` before any
 *   variant or route work, matching production resolution.
 * - `session.model?.variant` selects a variant; an explicit unknown variant fails with
 *   `VariantUnavailableError`.
 * - A model without a native route fails with `UnsupportedApiError`.
 * - On success returns the routed `Model` (route, defaults, auth) exactly as the
 *   production resolver hands it to the LLM client.
 */
export const resolveForTesting = (
  session: SessionSchema.Info,
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, ModelPrimeTimeError | VariantUnavailableError | UnsupportedApiError> =>
  checkPrimeTime(model).pipe(
    Effect.flatMap((model) => withVariant(model, session.model?.variant)),
    Effect.flatMap((model) => fromCatalogModel(model, credential)),
  )

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [Catalog.node, Integration.node] })
