# Provider / LLM Layer Behavior

## Scope

Behavior specification for the provider and LLM execution layer as implemented
today, covering three cooperating contours:

1. **Legacy (V1) provider service** — `packages/opencode/src/provider/`
   (catalog assembly, model/variant resolution, AI SDK execution, auth wiring).
2. **`@opencode-ai/llm`** — `packages/llm/` (schema-first native route runtime:
   protocols, routes, auth, framing, transports, streaming contract, HTTP
   executor with retries).
3. **V2 catalog contour** — `packages/core/src/{catalog,policy,credential,integration}.ts`
   and `packages/core/src/plugin/provider/*` (Location-scoped catalog built by
   plugins, policy filtering, credential storage/refresh), consumed by the V2
   session runner (`packages/core/src/session/runner/*`).

This document describes what the code does. It does not duplicate the V2 design
drafts `specs/v2/provider-model.md` (config-v2-provider-model) or
`specs/v2/provider-policy.md` (config-v2-policy); divergences between those
drafts and the implemented code are listed in
[Divergences from V2 drafts](#divergences-from-v2-drafts).

Out of scope: session orchestration internals (see `specs/v2/session.md`),
pricing/expense accounting, TUI model pickers.

## Layer Overview

```text
models.dev (https://models.opencode.ai/api.json)
  │ cached on disk, refreshed hourly            packages/core/src/models-dev.ts
  ▼
┌─────────────────────────────┐      ┌──────────────────────────────────────┐
│ V1 provider catalog         │      │ V2 catalog (Location-scoped)         │
│ packages/opencode/src/      │      │ packages/core/src/catalog.ts         │
│ provider/provider.ts        │      │ built by ProviderPlugins +           │
│ models.dev + config + env + │      │ ModelsDevPlugin + ConfigProviderPlugin│
│ auth + custom loaders       │      │ filtered by Policy.Service           │
└──────────┬──────────────────┘      └──────────────┬───────────────────────┘
           │ getLanguage() → AI SDK                │ SessionRunnerModel.resolve()
           ▼                                        ▼
  session/llm.ts runtime seam            packages/core/src/session/runner/llm.ts
  (ai-sdk default | native opt-in)       (native @opencode-ai/llm only)
           ▼                                        ▼
        ┌───────────────────────────────────────────────┐
        │ @opencode-ai/llm  (packages/llm)              │
        │ LLMClient.stream → Route → Protocol/Endpoint/ │
        │ Auth/Framing/Transport → RequestExecutor      │
        └───────────────────────────────────────────────┘
```

Both session runtimes converge on the same `LLMEvent` stream vocabulary; the
AI SDK path is converted (`packages/opencode/src/session/llm/ai-sdk.ts`),
the native path emits them directly.

## Model Catalog Source

**File:** `packages/core/src/models-dev.ts` (service `ModelsDev.Service`).

- Source URL: `Flag.OPENCODE_MODELS_URL` or `https://models.opencode.ai`
  (a mirror of the models.dev dataset), fetched from `${source}/api.json`
  with a `opencode/<channel>/<version>/<client>` User-Agent, 10s timeout,
  and a transient HTTP retry (2 times, jittered exponential from 200ms).
- Disk cache: `Global.Path.cache/models.json` (or `models-<hash>.json` for a
  custom source). Freshness TTL is **5 minutes** (mtime-based). Writes are
  atomic (tempfile + rename) and cross-process safe (`Flock` on a lock key
  derived from the path; re-check freshness under the lock).
- Population precedence: disk cache → build-time snapshot (the
  `OPENCODE_MODELS_DEV` compile-time define) → network fetch. With
  `OPENCODE_DISABLE_MODELS_FETCH` set and no disk/snapshot data, the catalog
  is `{}`.
- `Flag.OPENCODE_MODELS_PATH` overrides the load path for offline/fixture use;
  a corrupt default cache file is removed on load failure.
- Background refresh: unless disabled, a scoped fiber re-runs `refresh()` every
  60 minutes (`Schedule.spaced`), republishing `ModelsDev.Event.Refreshed`.
  V2 subscribes to that event and reloads the integration + catalog transforms
  (`packages/core/src/plugin/models-dev.ts`).

Schema (same file): `ModelsDev.Provider` (`api?`, `name`, `env[]`, `id`,
`npm?`, `models`) and `ModelsDev.Model` (limits, cost with tiers and
`context_over_200k`, modalities, `reasoning_options` —
`effort | toggle | budget_tokens`, `interleaved` (bool or field name),
`experimental.modes`, `status` restricted to `alpha | beta | deprecated`).

## V1 Provider Service

**File:** `packages/opencode/src/provider/provider.ts` (service
`@opencode/Provider`, per-directory `InstanceState`).

### Catalog assembly (InstanceState construction, in order)

1. `modelsDev.get()` → `catalog = mapValues(modelsDev, fromModelsDevProvider)`;
   a JSON-serializable `database` copy is derived via `toPublicInfo` (drops
   functions/symbols, stringifies bigints, keeps only schema-valid models).
2. Plugin `provider.models` hooks replace the model set of known providers
   (plugins run before `cfg.provider` is read so their `config()` hook is
   visible).
3. Config providers (`cfg.provider` entries) extend `database`: merged
   options, per-model overrides (api id/npm/url, capabilities, cost, limits,
   headers, prime-time fields, variants), `source: "config"`.
4. Environment: any provider whose `env` list has a set variable is merged with
   `source: "env"` and `key` (only when exactly one env var is declared).
5. Stored API-key auths (`auth.all()` with `type: "api"`) merge with
   `source: "api"`, `key`.
6. Plugin `auth.loader` hooks produce provider `options` patches for providers
   with stored auth.
7. Built-in `custom(dep)` loaders (`custom()` in the same file) supply
   per-provider behavior: model loaders, env var injectors, SDK options,
   model discovery. Providers covered: `anthropic` (beta headers),
   `opencode` (free-model gating), `openai`/`meta`/`xai` (responses API),
   `github-copilot` (responses vs chat selection), `azure` +
   `azure-cognitive-services` (resource name / deployment URLs), `amazon-bedrock`
   (region/profile/bearer-token/credential-chain, cross-region inference
   prefixes `us.`/`eu.`/`jp.`/`au.`/`apac.`/`global.`), `google-vertex` +
   `google-vertex-anthropic` (ADC fetch with Google Auth), `sap-ai-core`,
   `gitlab` (workflow model discovery), `cloudflare-workers-ai`,
   `cloudflare-ai-gateway` (native passthrough for `openai/`+`anthropic/`,
   unified compat for the rest), `snowflake-cortex`, plus header-only loaders
   (`openrouter`, `llmgateway`, `nvidia`, `vercel`, `cerebras`, `kilo`,
   `zenmux`).
8. Config providers re-apply (name/env/options) so config stays visible after
   loaders mutated state.
9. GitLab discovery merges dynamically discovered workflow models.
10. Filtering pass per provider: `enabled_providers`/`disabled_providers`
    allowlists, invalid chat aliases (`gpt-5-chat-latest` on openai/copilot/
    openrouter), `alpha` models removed unless
    `RuntimeFlags.enableExperimentalModels`, `deprecated` models removed,
    per-provider model `blacklist`/`whitelist`, variant merge (config variants
    filtered by `disabled` flag). Providers left with zero models are dropped.

`list()` returns the filtered set. `getProvider`/`getModel` read from it;
`getModel` produces fuzzy `suggestions` (fuzzysort, fallback substring
scoring) via `modelSuggestions` on `ModelNotFoundError`.

### Types

`Info` (`Provider`): `{ id, name, source: env|config|custom|api, env[], key?,
options, models }`. `Model`: `{ id, providerID, api: {id, url, npm}, name,
family?, capabilities (temperature/reasoning/attachment/toolcall/input/output
modalities/interleaved), cost (input/output/cache + tiers +
experimentalOver200K), limit {context, input?, output}, status, options,
headers, release_date, primeTime*, variants }` — schemas defined in the same
file; `ModelStatus` in `packages/opencode/src/provider/model-status.ts`
(`alpha | beta | deprecated | active`).

### Defaults

`defaultModel()` (`provider.ts`):

1. `cfg.model` (`provider/model` string, parsed by `parseModel` — first path
   segment is the provider, the rest is the model id).
2. Most recent entry from `Global.Path.state/model.json` (`recent[]`) still
   present in the live catalog.
3. Otherwise the first provider (preferring configured ones) and its
   best-ranked model by `sort()`: priority substring match on
   `["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]`, then
   non-`latest` ids, then id descending.

`getSmallModel(providerID)`: `cfg.small_model` if resolvable → plugin hook
`experimental.provider.small_model` → family priority
(`gemini-flash, gpt-nano, claude-haiku`; `gpt-nano` for opencode*, `gpt-mini`
first for github-copilot; Azure returns none) with Bedrock cross-region prefix
preferences.

### Language-model resolution (getLanguage / resolveSDK)

`getLanguage(model)` memoizes `${providerID}/${model.id}` →
`LanguageModelV3`. Resolution (`resolveSDK`):

- Provider `options` are copied; Vertex-Anthropic base URL derived when
  missing; Vertex non-compat options drop the ADC `fetch`;
  `@ai-sdk/openai-compatible` gets `includeUsage: true` unless disabled.
- `baseURL` resolution: explicit option → `model.api.url`, then `varsLoader`
  substitution (`${VAR}` from `vars()` callbacks, e.g. `AWS_REGION`,
  `GOOGLE_VERTEX_*`, `AZURE_RESOURCE_NAME`, `CLOUDFLARE_ACCOUNT_ID`), then
  environment substitution for any remaining `${VAR}` placeholders.
- `apiKey` falls back to `provider.key`; model headers merge over provider
  headers.
- SDK instance cache keyed by `Hash.fast(providerID, npm, options)`.
- The options `fetch` is wrapped with a timeout sandwich: `headerTimeout`
  (default 300s, `HeaderTimeoutError`), `chunkTimeout` (default 300s,
  enforced only for `text/event-stream` bodies via `wrapSSE`,
  `ResponseStreamError`), optional `options.timeout`
  (`AbortSignal.timeout`), all combined with `AbortSignal.any` alongside the
  caller signal. `chunkTimeout`/`headerTimeout`/`retries` keys are removed
  before SDK construction (`retries` is an opencode-level budget, not an AI
  SDK option).
- Bundled npm factories (`BUNDLED_PROVIDERS` map: all `@ai-sdk/*` used
  in-repo, `gitlab-ai-provider`, `venice-ai-sdk-provider`, copilot shim) are
  dynamically imported; anything else is installed at runtime via
  `Npm.add` and imported from its entrypoint (`file://` npm specs load
  directly). Loader failures become `InitError`.
- Per-provider `getModel` loaders then pick the concrete API surface
  (e.g. `sdk.responses(...)` for openai/meta/xai, Azure chat/responses by
  `useCompletionUrls`, Bedrock region-prefix logic, gateway passthrough
  wrappers).

### Z.ai vendor request parameters

**Files:** `packages/opencode/src/provider/transform.ts` (`options`),
`packages/opencode/src/session/llm/request.ts` (`prepare` merge order).

When the resolved model matches the Z.ai guard — providerID containing `zai`
or `zhipuai` with `api.npm === "@ai-sdk/openai-compatible"` (the Z.ai
OpenAI-compatible platform, base URL `https://api.z.ai/api/paas/v4`) —
`ProviderTransform.options` injects Z.ai vendor body parameters, which reach
the request body through the openai-compatible providerOptions passthrough:

- `thinking: { type: "enabled", clear_thinking: false }` — as-built default:
  enables model thinking and keeps (does not clear) thinking content in the
  response.
- `tool_stream: true` — Z.ai tool-call argument streaming (vendor feature:
  <https://docs.z.ai/guides/capabilities/stream-tool>): the API streams
  tool-call argument deltas as they are generated instead of buffering each
  call server-side until completion, lowering latency to the first argument
  token. Meaningful only for models that support tool calling (GLM-5 family);
  models without tool calling never emit tool-call deltas, so the parameter
  is inert for them.

Client readiness for unbuffered argument deltas:

- Native path (`packages/llm`): the shared accumulator
  (`protocols/utils/tool-stream.ts`) appends each delta to a raw string and
  parses JSON only at finalization, so partial argument text is handled by
  construction.
- Legacy AI SDK path (`@ai-sdk/openai-compatible`): partial argument chunks
  pass an `isParsableJson` guard — accumulated text is emitted only once it
  parses as complete JSON.

Known failure mode: when Z.ai emits the first tool-call delta for an index
without `id`, the legacy SDK stream decoder throws `InvalidResponseDataError`
(fixed upstream in AI SDK PR #47954); on the native path the same shape
surfaces as a typed `LLMError` with reason `InvalidProviderOutput`
(`eventError` in `protocols/shared.ts`) — the stream fails, the client does
not crash.

Both parameters are defaults, not forced values: `prepare` deep-merges
`model.options`, then `agent.options`, then the selected variant over the
`ProviderTransform.options` base (see Variant application order above), so
config can override either per model, agent, or variant (e.g.
`options.tool_stream: false`).

## Models and Variants

### V1 variants

Variants are per-model named request patches:
`Record<variantID, Record<string, any>>` layered onto provider options.
Generation:

- `ProviderTransform.reasoningVariants(model, base)`
  (`packages/opencode/src/provider/transform.ts`) — preferred when
  models.dev supplies `reasoning_options`: `effort` values map through
  `reasoningEffort` (per-npm wire shapes: `reasoning.effort`,
  `thinking.effort`, `thinkingConfig.thinkingLevel`,
  `reasoningConfig.maxReasoningEffort`, `reasoningEffort`, SAP `modelParams`,
  gateway slug routing), `budget_tokens` maps through `reasoningBudget`
  (high = `min(max(min, (max+1)/2), output-1, 32k-1)`, max = upper bound),
  `toggle` maps through `reasoningToggle` (alibaba/cohere).
- `ProviderTransform.variants(model)` — heuristic fallback keyed on
  `model.api.npm` with per-family effort matrices (OpenAI effort evolution by
  release date — `none` ≥ 2025-11-13, `xhigh` ≥ 2025-12-04, GPT-5.1/5.2/pro/
  codex/chat matrices; Anthropic adaptive thinking for Claude ≥ 4.7 with
  `display: "summarized"` when omitted, Opus 4.5 budget efforts, legacy
  budget 16k/31999 clamped by output limit; Gemini 2.5 budgets vs
  thinkingLevel; Bedrock reasoningConfig; copilot/groq/gateway/SAP special
  cases). Models without `capabilities.reasoning` produce `{}`; known
  non-reasoning families (deepseek-chat/reasoner/r1/v3, minimax, glm<5.2,
  kimi, qwen, big-pickle) produce `{}`.
- GitHub Copilot OAuth discovery (`plugin/github-copilot/models.ts`)
  builds variants from Copilot's `/models` capabilities instead of the
  heuristics above; every `adaptive_thinking` effort variant requests
  `thinking: {type: "adaptive", display: "summarized"}` so Copilot
  returns reasoning summaries.
- `models.dev experimental.modes` expand into synthetic models
  `${id}-${mode}` with camelCased body options (`modeOptions`; OpenAI
  `reasoning.mode` → `reasoningMode`).

Variant application order for a request
(`packages/opencode/src/session/llm/request.ts: prepare`):

```text
ProviderTransform.options(model, sessionID, providerOptions)   // base per-npm defaults
  ← mergeDeep model.options
  ← mergeDeep agent.options
  ← mergeDeep selected variant          // only when !small && user chose one
```

`smallOptions(model)` replaces the base for small-model calls (first variant,
`store:false` family, provider-specific thinking-off defaults).
`session.model.variant` reaches here from `StreamInput.user.model.variant`.
Azure + `useCompletionUrls` strips `reasoningSummary`/`include`.

### V2 variants

`ModelV2.Info.variants` is an array of `{ id, headers, body }`
(`packages/schema/src/model.ts`). Selection happens in
`SessionRunnerModel.withVariant` (`packages/core/src/session/runner/model.ts`):
`variantID === "default" | undefined` falls back to the model's configured
`request.variant`; an explicit unknown variant fails with
`VariantUnavailableError`; a found variant overlays `request.headers` and
`request.body` (immer `produce`). The `VariantPlugin`
(`packages/core/src/plugin/variant.ts`) generates GLM-5.2 `high`/`max`
`reasoning_effort` variants for openai-compatible models and keeps explicit
variants winning over generated ones with the same id.

## V1 Auth

**File:** `packages/opencode/src/auth/index.ts` (service `@opencode/Auth`).

- Storage: `Global.Path.data/auth.json`, written with mode `0600`. Schema is
  a discriminated union on `type`: `Oauth {refresh, access, expires,
  accountId?, enterpriseUrl?}`, `Api {key, metadata?}`,
  `WellKnown {key, token}`. `OPENCODE_AUTH_CONTENT` env var short-circuits
  the file wholesale (JSON).
- `set`/`remove` normalize keys by stripping trailing `/` and clean legacy
  variants of the same key. Reads decode with `Schema.decodeUnknownOption`
  and silently drop invalid entries.
- `OAUTH_DUMMY_KEY` is exported for providers that require a non-empty key
  alongside OAuth flows.

**Interactive flows:** `packages/opencode/src/provider/auth.ts`
(`ProviderAuth.Service`): `methods()` lists plugin-declared auth methods
(`oauth` with prompt forms incl. `when` conditions and validation, or `api`),
`authorize()` runs a plugin method's `authorize(inputs)` and parks the pending
`AuthOAuthResult` per provider, `callback()` completes it (code or auto mode)
and persists either an `Api` credential (`key` + `metadata`) or an `Oauth`
credential (`access`/`refresh`/`expires` + extra fields) through
`Auth.set`. Errors: `OauthMissing`, `OauthCodeMissing`, `OauthCallbackFailed`,
`ValidationFailed`.

**Credential routing into the catalog** happens during provider-state
assembly (see above): env vars → `source:"env"` + `key`; stored `Api` auth →
`source:"api"` + `key`; OAuth auths surface indirectly through plugin
`auth.loader` options patches (e.g. Azure `resourceName` from
`auth.metadata`, Bedrock `AWS_BEARER_TOKEN_BEDROCK`, SAP
`AICORE_SERVICE_KEY`, Snowflake combined fetch with refresh, GitHub Copilot
token exchange inside `@opencode-ai/core/github-copilot/copilot-provider`).
OpenAI OAuth additionally injects the system prompt as `instructions` and
keeps messages provider-shaped (`request.ts: isOpenaiOauth`).

## V2 Auth (integrations, credentials, accounts)

- `Credential.Service` (`packages/core/src/credential.ts`): SQLite table via
  Drizzle (`credential/sql.ts`); one credential row per integration
  (`create` replaces prior rows in a transaction). Values are
  `Credential.Key` or `Credential.OAuth {methodID, refresh, access, expires,
  metadata?}`.
- `Integration.Service` (`packages/core/src/integration.ts`):
  Location-scoped registry of auth methods (`key`, `env`, `oauth`) populated
  by plugins (including `ModelsDevPlugin`, which derives `key` + `env`
  methods from models.dev `env` lists). Connections are projected from stored
  credentials (newest first) plus currently-set env vars. `connection.resolve`
  returns env keys as `Credential.Key`, stored keys verbatim, and refreshes
  OAuth credentials when `expires` is within 5 minutes using the plugin's
  `refresh` implementation, persisting the new value.
- OAuth attempts are stateful and scoped: 10-minute lifetime, terminal states
  retained 1 minute, scrubbed every 30s; `mode: "auto"` callbacks settle in
  background fibers, `mode: "code"` requires `attempt.complete({code})`.
  `AuthorizationError` wraps implementation failures.
- `AccountV2` (`packages/core/src/account.ts`) defines the account/login
  vocabulary (device-code polling states, org info) used by account-style
  providers; it is a type module here, not a service.
- Concrete flows live in provider plugins, e.g.
  `packages/core/src/plugin/provider/openai.ts`: ChatGPT browser OAuth (PKCE
  + localhost callback server) and headless device auth, both with
  `refresh_token` refresh and ChatGPT account-id extraction from token
  claims.

## `@opencode-ai/llm` Streaming Contract

**Package:** `packages/llm` (see its `AGENTS.md`/`README.md` for contributor
guides; `DESIGN.md` is a future-direction draft, not current behavior).

### Request shape and construction

`LLM.request({...})` (`src/llm.ts`) normalizes ergonomic inputs into the
canonical `LLMRequest` schema class (`src/schema/messages.ts`): `system`
(initial privileged prompt), `messages`, `tools` (`ToolDefinition`),
`toolChoice`, `generation` (`GenerationOptions`: maxTokens, temperature, topP,
topK, penalties, seed, stop), `providerOptions`
(`Record<provider, Record<string, unknown>>`), `http` overlay
(`{body, headers, query}`), `cache` policy, and the executable `model`.
`LLM.updateRequest` round-trips through the input shape. `LLM.generateObject`
forces a synthetic `generate_object` tool and decodes its input against the
schema (uniform across protocols; no provider JSON modes).

### Route composition

`Route.make({ id, provider?, protocol, endpoint, auth?, framing, headers?,
defaults? })` (`src/route/client.ts`) composes four orthogonal pieces:

- **Protocol** (`src/route/protocol.ts`): `body.schema` + `body.from` (builds
  the provider-native body), `stream.event` (frame schema), `stream.initial/
  step[/terminal][/onHalt]` (event → `LLMEvent` state machine). Implemented
  protocols (`src/protocols/`): `openai-chat`, `openai-responses` (HTTP +
  WebSocket routes), `anthropic-messages`, `gemini`, `bedrock-converse`
  (binary AWS event-stream framing), `openai-compatible-chat` (no canonical
  URL, requires configuration).
- **Endpoint** (`src/route/endpoint.ts`): `{baseURL?, path, query?}` with
  path as a string or function of `{request, body}`.
- **Auth** (`src/route/auth.ts`): composable header injectors. `Credential`
  values (`value/optional/config/effect`) render as `bearer()`/`header()`/
  `bearerHeader()`; `andThen`/`orElse` compose; `custom` takes a signing
  function (used by Bedrock SigV4 in `protocols/utils/bedrock-auth.ts`).
  Missing credentials surface as typed `LLMError.Authentication` (`kind:
  "missing"`). `AuthOptions.bearer(options, envVars)`
  (`src/route/auth-options.ts`) is the standard facade resolution: explicit
  `auth` override → `apiKey` option → `Auth.config(envVar)` chain.
- **Framing** (`src/route/framing.ts`): `Framing.sse` for JSON-streaming
  providers; Bedrock's event-stream framing is a typed `Framing` value.
- **Transport** (`src/route/transport/`): `HttpTransport.httpJson` (POST +
  framing) is the default; `WebSocketTransport.json` + `WebSocketExecutor`
  cover non-HTTP transports (OpenAI Responses WebSocket route).

`route.with(patch)` returns a configured copy (merged defaults, merged
endpoint, auth/transport replacement). `route.model({...})` constructs a
`Model` value (`{id, provider, route, defaults?, compatibility?}`,
`src/schema/options.ts`) and throws when no provider identity or endpoint
`baseURL` is available.

Provider facades (`src/providers/`) bind deployment configuration before model
selection — e.g. `OpenAI.configure({apiKey, baseURL}).responses(id)`
(`src/providers/openai.ts`) — with typed option surfaces
(`src/providers/openai-options.ts`). Included: OpenAI, Anthropic, Google,
Amazon Bedrock, Azure, Cloudflare (AI Gateway + Workers AI), GitHub Copilot,
OpenRouter, xAI, and generic OpenAI-compatible helpers with family profiles
(DeepSeek, Groq, Together, Cerebras, ...).

### Compile / stream / generate

`LLMClient` (`src/route/client.ts`, service `@opencode/LLMClient`, layer over
`RequestExecutor.Service` and optional `WebSocketExecutor`):

1. `compile(request)`: `resolveRequestOptions` merges defaults with precedence
   `route.defaults → model.defaults → request` (per-axis merges:
   `GenerationOptions` last-writer-wins per knob, provider options and http
   deep-merged), then `applyCachePolicy`, then `body.from` → validate against
   `body.schema` → `prepareTransport`.
2. `stream(request)`: returns `Stream<LLMEvent, LLMError>` — transport frames
   → schema-decoded protocol events → state machine → normalized events.
   `Stream.takeUntil(terminal)` stops at completion sentinels; `onHalt`
   flushes final events; decode/stream failures become typed
   `InvalidProviderOutput` errors carrying route id and raw payload.
3. `generate(request)`: folds the stream with `LLMResponse.reduce` and
   requires a terminal `finish`/`provider-error` event — otherwise
   `InvalidProviderOutput("Provider stream ended without a terminal finish
   event")`.
4. `prepare<Body>(request)`: compile without sending; returns
   `PreparedRequest {id, route, protocol, model, body, metadata}`.

`LLM.stream` / `LLM.generate` re-export the service-backed calls; each runs
**exactly one provider turn** (tool dispatch is caller-owned via
`ToolRuntime.dispatch`, `src/tool-runtime.ts`; `providerExecuted: true` calls
skip local dispatch).

### Event vocabulary and response assembly

`LLMEvent` union (`src/schema/events.ts`): `step-start`, `text-start/delta/
end`, `reasoning-start/delta/end`, `tool-input-start/delta/end`, `tool-call`,
`tool-result`, `tool-error`, `step-finish`, `finish`, `provider-error`.
`LLMResponse` (`message`, `events`, `usage?`, `finishReason`) is assembled by
a pure reducer with `text`/`reasoning`/`toolCalls` accessors.

`Usage` carries both inclusive totals (`inputTokens` includes cached reads and
writes) and a non-overlapping breakdown (`nonCachedInputTokens`,
`cacheReadInputTokens`, `cacheWriteInputTokens`, `reasoningTokens`), with the
invariant `nonCached + cacheRead + cacheWrite = inputTokens`,
`reasoning ≤ output`, `Math.max(0, …)` clamping against provider bugs, and
the raw provider payload in `providerMetadata`. Anthropic reports the
breakdown natively (mapper sums); OpenAI/Gemini/Bedrock report inclusive
totals (mapper subtracts).

### Cache policy

`src/cache-policy.ts` runs at compile time. Default (undefined or `"auto"`):
three breakpoints — last tool definition, last system part, latest user
message — as `ephemeral` `CacheHint`s, preserving existing manual hints.
`"none"` disables auto placement; the object form configures each axis
(`messages: "latest-user-message" | "latest-assistant" | {tail}`, plus
`ttlSeconds` — ≥ 3600 selects 1h on Anthropic/Bedrock). Policy application is
skipped entirely for routes whose wire format ignores inline markers
(`RESPECTS_INLINE_HINTS = anthropic-messages, bedrock-converse`); OpenAI and
Gemini rely on implicit server-side caching.

## Provider Error Handling and Retries

### Error taxonomy

`LLMError {module, method, reason}` (`packages/llm/src/schema/errors.ts`) —
reason union with retryability:

| Reason | Retryable | Typical source |
|---|---|---|
| `InvalidRequest` (classification `context-overflow`?) | no | body validation, 400/404/409/413/422 |
| `NoRoute` | no | route resolution |
| `Authentication` (`missing/invalid/expired/insufficient-permissions/unknown`) | no | auth apply, 401/403 |
| `RateLimit` (retryAfterMs?, rateLimit details) | **yes** | 429 |
| `QuotaExceeded` | no | 429 with quota body |
| `ContentPolicy` | no | 4xx with policy markers |
| `ProviderInternal` (status, retryAfterMs?) | **yes** | ≥500, 429/503/504/529 |
| `Transport` (kind?) | no | HTTP client failures, timeouts |
| `InvalidProviderOutput` (route?, raw?) | no | stream decode, missing finish |
| `UnknownProvider` | no | everything else |

`isContextOverflow(message)` (`packages/llm/src/provider-error.ts`) matches a
regex battery of provider overflow phrasings (excluding rate-limit-ish
messages); `isContextOverflowFailure` checks either an `LLMError` with
`InvalidRequest` + `context-overflow` or a `provider-error` event with the
same classification.

### HTTP executor retries

`RequestExecutor.Service` (`packages/llm/src/route/executor.ts`):

- Up to **2 retries** (3 attempts) for `LLMError`s whose reason is retryable
  (`RateLimit`, `ProviderInternal`). Delay: `retry-after-ms`/`retry-after`
  (seconds or HTTP-date, capped at 10s) when present; otherwise jittered
  exponential backoff (base 500ms × 2^attempt, ±20%, cap 10s).
- Status mapping (before retry decisions): 401 → `Authentication.invalid`,
  403 → `insufficient-permissions`, 429 → `QuotaExceeded` when the body says
  quota, else `RateLimit` with parsed rate-limit headers (OpenAI
  `x-ratelimit-*-{limit,remaining,reset}`, Anthropic
  `anthropic-ratelimit-*`), 400/404/409/413/422 → `InvalidRequest` with
  `context-overflow` classification when `isContextOverflow(body)`, ≥500 and
  retryable statuses → `ProviderInternal`, policy-marker bodies →
  `ContentPolicy`.
- Diagnostics hygiene: request/response headers, URL query, and body fields
  matching the sensitive-name regex battery are redacted (`<redacted>`), body
  snapshots truncate at 16 KB, and literal secret values echoed by responses
  are replaced. Known request-id headers are captured
  (`x-request-id`, `x-amzn-requestid`, `x-goog-request-id`, `cf-ray`, ...).

### Session-level retry policy (V1)

`packages/opencode/src/session/retry.ts`: bounded schedule on top of the
provider call — default **5 retries** (`RETRY_MAX_RETRIES`, overridable per
request via `retries`; 0 disables), delay from `retry-after-ms` /
`retry-after` (numeric seconds or HTTP date, capped at 2^31−1 ms) else
jittered exponential (2s base, ×2, ±25%, 30s cap without headers).
Retryability classification (`retryable()`): `ContextOverflowError` never;
`APIError` when `isRetryable`, status ≥ 500, or message/response-body matches
the `RETRYABLE_MESSAGE_PATTERNS` battery (rate/5xx/overloaded/network/timeout
phrasings); OpenAI-provider 404s count as retryable
(`isOpenAiErrorRetryable`). Free-tier/Go upsell responses produce retry
actions with links. Because retries live here, the AI SDK call itself is made
with `maxRetries: 0` and provider option `retries` is stripped in
`resolveSDK`.

Stream errors from the AI SDK path are classified by
`packages/opencode/src/provider/error.ts`: `parseAPICallError` (context
overflow vs api_error with retryability and metadata) and
`parseStreamError` (Anthropic-style `type: "error"` payloads:
`context_length_exceeded`, `insufficient_quota`, `usage_not_included`,
`invalid_prompt`, overloaded/server errors). `finish-step` with
`rawFinishReason === "network_error"` fails the stream as
`ProviderError.ResponseStreamError` (`session/llm/ai-sdk.ts`).

The V2 runner currently has **no provider retry loop** — a failed turn fails
the drain (the header checklist in `session/runner/llm.ts` tracks "Bound
provider retries" as an open item); context-overflow failures before any
assistant output route into overflow compaction instead.

## Session Integration (V1)

**File:** `packages/opencode/src/session/llm.ts` (service `@opencode/LLM`)
with adapters under `packages/opencode/src/session/llm/`:

1. **Prime-time gate** (before any provider resolution): `primeTimeActive`
   (config-v1 R17 semantics, `packages/core/src/v1/config/provider.ts`).
   Blocked models fail terminally, or — with `primeTimeRetry` — as a
   retryable `APIError` with synthetic `retry-after-ms` pointing at the
   window end (window end omitted when the window never ends; the retry
   budget then exhausts into the terminal error).
2. Concurrent resolution of `getLanguage`, config, provider info, and stored
   auth; `LLMRequestPrep.prepare` (`llm/request.ts`) assembles system
   (agent prompt or provider default + config + user system, plugin
   `chat.system.transform`), message list (system folded as messages unless
   OpenAI-OAuth/workflow), tools (permission-filtered; OpenAI Responses
   family forces `strict: false`; Copilot gets a `_noop` tool when replaying
   tool calls), sampling params via plugin `chat.params` (model-default
   temperature/topP/topK from `ProviderTransform`, `maxOutputTokens`
   clamped by `OUTPUT_TOKEN_MAX` 32 000 and `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`),
   and headers via plugin `chat.headers` (session affinity, parent session,
   model headers, opencode project/session/request/client ids).
3. **Runtime seam:** when `OPENCODE_EXPERIMENTAL_NATIVE_LLM` is set,
   `LLMNativeRuntime.stream` (`llm/native-runtime.ts`) is tried first. It
   supports providers `openai`, `anthropic`, `opencode*` on npm packages
   `@ai-sdk/openai`, `@ai-sdk/openai-compatible` (explicit base URL
   required), `@ai-sdk/anthropic`; OAuth auth only for OpenAI with a
   provider fetch override; API key from provider options or catalog key.
   Unsupported combinations log the reason and fall back to the AI SDK path.
   The lowering adapter (`llm/native-request.ts`) builds the native
   `LLMRequest` — mapping AI SDK message/part shapes to canonical parts,
   picking the facade per `model.api.npm` (openai/azure → `responses`,
   anthropic → `model`, google/bedrock/openrouter → `model`, compatible →
   `OpenAICompatible.configure({provider, baseURL})`) — and the runtime
   bridges one provider turn with opencode-owned tool dispatch through
   `ToolRuntime`.
4. **Default path:** AI SDK `streamText` with the wrapped language model
   (`transformParams` applies `ProviderTransform.message` — surrogate
   sanitization, provider message normalization, Anthropic/Bedrock empty
   message filtering, claude/mistral tool-call id scrubbing, DeepSeek
   reasoning replay, interleaved reasoning field lowering, prompt caching
   markers, providerOptions key remapping by `sdkKey`, Responses `itemId`
   stripping when `store !== true`), `experimental_repairToolCall` (case
   fix-up else `invalid` tool), telemetry when enabled, `maxRetries: 0`.
   `LLMAISDK.toLLMEvents` (`llm/ai-sdk.ts`) converts `fullStream` parts to
   `LLMEvent`s, tracking block ids, tool names, usage (incl. cache and
   reasoning breakdown), Copilot `total_nano_aiu` from raw chunks, and
   resets state at `finish`.
5. GitLab workflow models get a dedicated bridge: session id, system prompt,
   tool executor over opencode tools, pre-approved tool lists from the
   session permission ruleset, and an approval handler wired to
   `Permission.ask` with per-session auto-approval memory.

## V2 Catalog and Runner Model Resolution

**Catalog:** `packages/core/src/catalog.ts` (`@opencode/v2/Catalog`,
Location-scoped node). State: `Map<providerID, {provider, models: Map}>` plus
an optional `defaultModel`. Plugins mutate it through `State.Transformable`
drafts (`provider.update` auto-creates `ProviderV2.Info.empty`,
`model.update` auto-creates `ModelV2.Info.empty`, both normalizing legacy
`request.body.baseURL` into `api.url`). On finalize, when policy statements
exist, every provider denied by `Policy.evaluate("provider.use", id, "allow")`
is **removed** from the catalog, then `Catalog.Event.Updated` is published.

Read semantics:

- `provider.available()`: not `disabled`, and (has `request.body.apiKey`) or
  (its integration has connections) or (no integration is referenced at all).
- `model.get/all`: models are projected with provider defaults — native APIs
  inherit provider url/settings when empty; aisdk model APIs inherit provider
  url and merged settings; request headers/body merge provider over model.
  `model.all` sorts by `time.released` descending.
- `model.available()`: models of available providers with `enabled`.
- `model.default()`: the recorded default (config `model` key) when its
  provider is available and the model enabled; else the newest available
  model.
- `model.small(providerID)`: Azure providers return none; opencode prefers
  `gpt-5-nano`; otherwise a cost/recency heuristic over enabled, active,
  text-in/text-out models (age ≤ 18 months, cost > 0, name/family matches
  `nano|flash|lite|mini|haiku|small|fast` preferred; weighted 0.8 cost + 0.2
  age).

**Policy:** `packages/core/src/policy.ts` — statements
`{action, effect, resource}`; `evaluate` = last wildcard match wins
(`Wildcard.match` on both action and resource) with a caller-supplied
fallback. Statements are loaded by the V2 config service
(`packages/core/src/config.ts`) from `experimental.policies` across config
documents in **reverse document order** (user-global last-wins over
repository), preserving written order inside each document; the accepted
action union is `provider.use` (`config/experimental.ts`,
`Catalog.PolicyActions`).

**Catalog population:**

- `ModelsDevPlugin` (`packages/core/src/plugin/models-dev.ts`): integration
  methods (`key` + `env`) for every provider with `env` entries; provider and
  model records from models.dev (aisdk api when `npm` present, else native;
  cost array with tiers and synthetic 200k tier; experimental modes as
  `${id}-${mode}` models with merged cost); reloads on
  `ModelsDev.Event.Refreshed`.
- `ConfigProviderPlugin` (`packages/core/src/config/plugin/provider.ts`):
  config `providers` overlay — names, env methods, provider api/request,
  per-model family/name/api/capabilities/request/variants/cost/disabled/limit
  — and the configured default model.
- `ProviderPlugins` (`packages/core/src/plugin/provider/`): 34 built-ins that
  adjust integrations (OAuth methods), catalog entries (e.g. OpenAI hides the
  chat-only `gpt-5-chat-latest` alias), and AI SDK construction
  (`ctx.aisdk.sdk` / `ctx.aisdk.language` seams), alongside the V1-style
  per-provider behavior described above.

**Runner model resolution:**
`packages/core/src/session/runner/model.ts` (`SessionRunnerModel.Service`,
Location layer over Catalog + Integration):

1. Explicit `session.model` must be in `model.available()` (else
   `ModelUnavailableError`); otherwise the catalog default if supported, else
   the first available supported model; nothing found →
   `ModelNotSelectedError`.
2. `checkPrimeTime(selected)` — terminal `ModelPrimeTimeError` inside an
   active window (`primeTimeRetry` is carried but inert on this path, per
   config-v2-provider-model).
3. Provider lookup, active integration connection, credential resolution
   (with OAuth refresh).
4. Variant overlay, then `fromCatalogModel`: key credentials from
   `Credential` values or `request.body.apiKey`/`api.settings.apiKey`; key
   credential metadata is merged into `request.body`; routes map
   `aisdk:@ai-sdk/openai` → `OpenAIResponses.route` (bearer),
   `aisdk:@ai-sdk/anthropic` → `AnthropicMessages.route`
   (`x-api-key` header), `aisdk:@ai-sdk/openai-compatible` + explicit URL →
   `OpenAICompatibleChat.route` (bearer); anything else fails with
   `UnsupportedApiError`. `withDefaults` overlays provider/model headers,
   body (minus `apiKey`) as an http body overlay, limits, and endpoint base
   URL. `supported()` exposes the same predicate.

The V2 runner (`packages/core/src/session/runner/llm.ts`) then issues exactly
one `llm.stream(request)` per provider turn (session affinity headers,
`promptCacheKey` from the session id), publishes events durably, settles tool
calls through the registry, reloads projected history before continuation,
and routes pre-output context overflow into overflow compaction.

## Module Map

### packages/opencode/src/provider/

| File | Responsibility | Contract |
|---|---|---|
| `provider.ts` | V1 catalog service, custom loaders, SDK resolution, defaults | `Interface {list, getProvider, getModel, getLanguage, closest, getSmallModel, defaultModel}`; `Info`/`Model` schemas; `ModelNotFoundError`/`InitError`/`NoProvidersError`/`NoModelsError` |
| `transform.ts` | Provider-specific message/providerOptions/schema lowering, variants, sampling defaults | pure functions over `Provider.Model`; `OUTPUT_TOKEN_MAX = 32 000`; `sdkKey` npm→providerOptions key map |
| `auth.ts` | Interactive provider auth flows | `methods/authorize/callback` over plugin auth hooks; persists via `Auth.set` |
| `error.ts` | AI SDK error classification | `parseAPICallError`, `parseStreamError`, `HeaderTimeoutError`, `ResponseStreamError` |
| `model-status.ts` | Status literal re-export | `alpha/beta/deprecated/active` |

### packages/opencode/src/auth/

| File | Responsibility | Contract |
|---|---|---|
| `index.ts` | Credential store | `get/all/set/remove` over `auth.json` (0600) or `OPENCODE_AUTH_CONTENT`; `Oauth/Api/WellKnown` union |

### packages/opencode/src/session/llm*

| File | Responsibility |
|---|---|
| `llm.ts` | Runtime seam: prime-time gate, request prep orchestration, native vs ai-sdk selection, GitLab workflow bridge |
| `llm/request.ts` | System/message/tool/param/header assembly with plugin hooks and merge order |
| `llm/native-request.ts` | The only opencode→`@opencode-ai/llm` request adapter (facade selection per `model.api.npm`) |
| `llm/native-runtime.ts` | Native support gate + one-turn stream with opencode-owned tool dispatch |
| `llm/ai-sdk.ts` | AI SDK `fullStream` → `LLMEvent` conversion |
| `retry.ts` | Session retry schedule, retryability classification, retry-after computation |

### packages/llm/src/

| Area | Files | Responsibility |
|---|---|---|
| schema | `ids/options/messages/events/errors` | Canonical data model: branded ids, options + merges, `LLMRequest`, `LLMEvent`/`LLMResponse`/`Usage`, `LLMError` taxonomy |
| llm | `llm.ts` | `LLM.request/updateRequest/generate/stream/generateObject` |
| route | `client/executor/protocol/endpoint/auth/auth-options/framing` + `transport/` | Route composition, compile/stream/generate pipeline, HTTP executor with retries and redaction |
| protocols | `openai-chat`, `openai-responses`, `anthropic-messages`, `gemini`, `bedrock-converse`, `bedrock-event-stream`, `openai-compatible-chat`, `shared`, `utils/*` | Wire contracts: body building + stream parsing per protocol family |
| providers | `openai`, `anthropic`, `google`, `amazon-bedrock`, `azure`, `cloudflare`, `github-copilot`, `openrouter`, `xai`, `openai-compatible{,-profile}`, `openai-options` | Configured facades binding endpoint/auth before model selection |
| tools | `tool.ts`, `tool-runtime.ts` | Typed tool construction and one-call dispatch (`ToolFailure` boundary; defects fail the stream) |
| policy | `cache-policy.ts` | Auto cache breakpoint placement |
| errors | `provider-error.ts` | Context-overflow regex battery |

### packages/core/src/ (V2)

| File | Responsibility |
|---|---|
| `models-dev.ts` | Catalog fetch/cache/refresh service |
| `catalog.ts` | Location catalog service with policy filtering and projection |
| `policy.ts` | Statement store + last-match-wins evaluator |
| `credential.ts` + `credential/sql.ts` | SQLite credential store (key/oauth values) |
| `integration.ts` | Auth method registry, connections, OAuth attempts with refresh |
| `account.ts` | Account/login type vocabulary |
| `provider.ts`, `model.ts` | `ProviderV2`/`ModelV2` re-exports of `packages/schema` |
| `plugin/models-dev.ts`, `plugin/provider/*`, `plugin/variant.ts` | Catalog population plugins |
| `config/plugin/provider.ts`, `config/experimental.ts` | Config overlay onto the catalog; policy statement schema |
| `session/runner/model.ts` | Session model resolution (prime-time, variant, credential, route) |
| `session/runner/llm.ts` | One-turn provider streaming with durable settlement |

## Invariants, Stubs, and Limitations

Invariants:

- One provider turn = one explicit `llm.stream(request)` call; tool execution
  and continuation are session-owned (enforced by runner structure and the
  AGENTS.md V2 rules).
- `generate` requires a terminal `finish`/`provider-error` event; protocols
  must emit exactly one terminal event per response (parser state owns
  finish reason/usage merging).
- Usage invariant: `nonCachedInputTokens + cacheReadInputTokens +
  cacheWriteInputTokens = inputTokens`; all clamps are `Math.max(0, …)`.
- Model ids are unique only within a provider; both catalogs key models by
  provider first.
- Executor redaction always applies to sensitive headers/query/body fields
  and echoed secrets before errors surface.
- V1 `auth.json` writes are 0600; V2 credentials live in SQLite with
  one-credential-per-integration replacement.
- Prime-time is evaluated before provider lookup/credential/route work on
  both paths; V1 additionally supports the retryable flavor.
- Config → catalog overlay ordering: V1 merges config providers before env/
  auth/custom loaders and re-applies config afterwards; V2 policy reads
  config documents reversed so user-global policy wins.

Stubs / known limitations:

- Native runtime (V1 seam) covers only openai/anthropic/opencode providers;
  everything else silently falls back to the AI SDK path (logged).
- V2 runner: no provider retry loop, no repeated-identical-tool-call bound,
  no post-crash continuation recovery (tracked in the runner checklist).
- V2 `model.small`/`default` heuristics carry explicit TODOs about provider
  assumptions (Azure) and deployment reporting.
- `ProviderTransform.normalizeMessages` is self-flagged as inefficient
  ("TODO: fix this stupid inefficient dogshit function").
- Bedrock/SAP loaders mutate `process.env` directly pending Env API scope
  clarification (inline TODOs).
- V1 catalog treats models.dev `status` absent as `active`; the models.dev
  schema itself only validates `alpha/beta/deprecated` there.
- Z.ai `tool_stream` vendor parameter streams tool-call argument deltas
  unbuffered; a first delta lacking `id` breaks the legacy AI SDK stream
  (`InvalidResponseDataError`, fixed upstream in PR #47954) while the native
  path fails with a typed `InvalidProviderOutput` error instead.
- `openai/responses` WebSocket transport exists as a route
  (`OpenAIResponses.webSocketRoute` + `WebSocketExecutor`); the V2 resolver
  does not select it (no silent downgrade either — see draft note).

## Divergences from V2 Drafts

Against `specs/v2/provider-model.md` (config-v2-provider-model):

1. **Provider schema:** implemented `ProviderV2.Info`
   (`packages/schema/src/provider.ts`) is `{id, integrationID?, name,
   disabled?, api: AISDK|Native, request: {headers, body}}` — not the
   draft's `enabled` union (`false | via env/account/custom`), no `env`
   array, no `options {headers, body, aisdk}` triple, and no `Endpoint`
   union with `openai/responses|openai/completions|anthropic/messages|
   unknown` literals. Availability is computed from integrations/credentials
   (`catalog.available`), and protocol selection happens in
   `SessionRunnerModel.fromCatalogModel` by `api.package`, not by an
   endpoint type tag.
2. **Model schema:** `ModelV2.Info` uses `api: Model.Api` + `request {headers,
   body, variant}` instead of `endpoint + options`, `variants` is an array of
   `{id, headers, body}` instead of `Variant = {id, ...Options.fields}`, and
   `time.released` is `Schema.Finite` (epoch millis) rather than a
   `DateTimeUtcFromMillis` decode.
3. **Catalog interface:** `model.get` returns `Info | undefined` instead of
   failing with `ProviderNotFoundError | ModelNotFoundError`;
   `model.default()` returns the configured default or the **newest**
   available model (release-date sort), not "first available with a
   supported route"; the runner, not the catalog, applies the
   supported-route fallback. `model.small` uses the cost/recency/name
   heuristic described above rather than a family priority list.
4. **Plugin interface:** there is no `account.update/remove/activate/
   activated` hook set and no numeric `Plugin Order` constant. Plugins are
   `define({id, effect})` values mutating `ctx.integration` / `ctx.catalog` /
   `ctx.aisdk` drafts; account-style state lives in
   `Integration`/`Credential` services instead.
5. **Prime-time:** implemented as specified (terminal `ModelPrimeTimeError`,
   `checkPrimeTime` delegating to the config-v1 predicate; `primeTimeRetry`
   carried but inert on the V2 path — the retryable flavor exists only in
   the V1 session seam, `packages/opencode/src/session/llm.ts`).
6. **Runner adaptation surface:** matches the draft's list minus WebSocket —
   the draft says WebSocket responses "must not silently downgrade to HTTP";
   the code simply has no WebSocket branch on this path (unsupported
   packages fail with `UnsupportedApiError`).

Against `specs/v2/provider-policy.md` (config-v2-policy):

1. **Evaluation** (`packages/core/src/policy.ts`) matches the draft's
   last-match-wins `findLast` evaluator and wildcard matching on both action
   and resource.
2. **Denied providers are removed entirely** at catalog finalize (not
   retained as disabled records) — the draft left this open.
3. **Cross-document ordering** is implemented as the draft's reverse-document
   read (`packages/core/src/config.ts` loads `experimental.policies` from
   reversed config documents); statements keep written order inside each
   document. Managed/organization policy is not implemented.
4. The typed statement schema (`config/experimental.ts`) fixes `action` to
   `provider.use` via `Catalog.PolicyActions`, matching the draft's
   domain-defined statement design.

## Dependencies

- config-v1 (R17 prime-time window semantics, R18 retryable prime-time) —
  evaluated by both session seams via `primeTimeActive` /
  `primeTimeWindowEnd`.
- config-v2 — the `providers`/`experimental.policies` config surface that
  feeds the V2 catalog and policy services.

## Used by

- `specs/v2/session.md` — the V2 runner consumes the catalog/model resolver
  described here.
- `specs/v2/provider-model.md`, `specs/v2/provider-policy.md` — design drafts
  this document grounds in current behavior.
