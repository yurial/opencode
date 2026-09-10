# Server, HTTP API, Protocol, and SDK

Status: draft (as-built behavior specification — describes what the current code
does; divergences from design specs and AGENTS.md are called out inline and
listed at the end).

Reference: `server-api-sdk`

Related documents (not duplicated here):

- `packages/opencode/specs/effect/routes.md` (reference `effect-routes`) —
  handler shape, error-boundary and OpenAPI-compatibility conventions for the
  legacy HttpApi route tree under `packages/opencode/src/server/routes/`.
- `packages/opencode/specs/openapi-translation-cleanup.md` (reference
  `openapi-cleanup`) — plan for shrinking the legacy OpenAPI translation layer
  in `packages/opencode/src/server/routes/instance/httpapi/public.ts`.
- `packages/opencode/specs/effect/server-package.md` (reference
  `effect-server-package`) — the extraction plan that produced today's
  `packages/server`; this spec records its realized state.
- `specs/core-session.md` (V2 Session semantics behind `session.*` routes),
  `specs/event-retention.md` (event pruning), `specs/v2/schema-changelog.md`
  (HTTP/SDK schema change ledger).
- `AGENTS.md` — dependency-direction and regeneration rules, restated and
  verified in [Package topology](#package-topology) below.

## Scope

In:

- `packages/protocol/` — the wire contract package: HttpApi group
  declarations, public error schemas, middleware markers, and the
  `makeApi`/`makeDefaultApi` API factory.
- `packages/server/` — the V2 HTTP server package: concrete API assembly,
  middleware implementations (location, session-location, authorization,
  schema-error), route handlers, CORS policy, and the embedded/web-handler
  entrypoints.
- `packages/client/` — the private generation target: client contract,
  codegen entrypoint (`bun run generate`), generated `src/generated` and
  `src/generated-effect` trees, and the boundary tests that police them.
- `packages/httpapi-codegen/` — the internal code generator used by
  `packages/client`.
- `packages/sdk/` — the published legacy JavaScript SDK `@opencode-ai/sdk`
  (root and `/v2` entrypoints, hey-api generation pipeline, server spawner).
- `packages/sdk-next/` — the in-process Effect-native host that will replace
  `@opencode-ai/sdk`.
- SDK generation flows: `bun run generate` from `packages/client`,
  `./packages/sdk/js/script/build.ts` from repo root, and the `opencode
  generate` OpenAPI command they consume.
- How the server is hosted: `opencode serve` (CLI), the embedded host
  (sdk-next), and the legacy hosting in `packages/opencode/src/server/server.ts`
  at boundary level.

Out:

- Legacy V1 route-group behavior (`/session`, `/config`, `/experimental/*`, …)
  — only their composition into the public API and their effect on SDK
  generation; per-route behavior lives with `effect-routes`.
- The OpenAPI compatibility transform contents of
  `httpapi/public.ts` — owned by `openapi-cleanup`.
- V2 Session/permission/question domain semantics — see `specs/core-session.md`
  and `specs/core-tools-permissions.md`.
- The legacy V1 server's mDNS/WebSocket-tracker/lifecycle internals beyond
  their boundary effects.

## Key files

| File | Responsibility |
|---|---|
| `packages/protocol/src/api.ts` | `makeApi`/`makeDefaultApi`: composes all `server.*` groups into one HttpApi, owns middleware placement, takes host-injected middleware keys |
| `packages/protocol/src/groups/*.ts` | One HttpApiGroup per domain (`server.session`, `server.fs`, `server.pty`, …): endpoints, query/payload/success schemas, OpenApi annotations |
| `packages/protocol/src/errors.ts` | Public tagged error classes with `httpApiStatus` (`InvalidRequestError` 400, `UnauthorizedError` 401, `SessionNotFoundError` 404, …) |
| `packages/protocol/src/middleware/authorization.ts` | `Authorization` middleware marker (error: `UnauthorizedError`) |
| `packages/protocol/src/middleware/schema-error.ts` | `SchemaErrorMiddleware` marker (error: `InvalidRequestError`) |
| `packages/protocol/src/groups/location.ts` | `LocationQuery` (`location[directory]`/`location[workspace]` deepObject query) and `locationQueryOpenApi` style annotation |
| `packages/server/src/api.ts` | `Api = makeDefaultApi({locationMiddleware, sessionLocationMiddleware})` binding Protocol to Server's concrete middleware |
| `packages/server/src/routes.ts` | `createRoutes(password?)` / `createEmbeddedRoutes()` / `webHandler()`: handler + middleware + service layer stack, `openapiPath: "/openapi.json"` |
| `packages/server/src/location.ts` | `LocationMiddleware`: resolves `Location.Ref` per request (query/header/cwd), provides `LocationServices`; `response()` `{location, data}` envelope helper |
| `packages/server/src/middleware/session-location.ts` | `SessionLocationMiddleware`: resolves Location from the session's DB row; 400/404 on invalid/unknown session |
| `packages/server/src/middleware/authorization.ts` | Basic-auth enforcement (header or `auth_token` query), PTY-ticket exemption, `www-authenticate` on rejection |
| `packages/server/src/middleware/schema-error.ts` | Maps HttpApi schema rejections to `InvalidRequestError` (truncated reason, `kind`), logs warning |
| `packages/server/src/auth.ts` | `ServerAuth.Config` (env `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`), `required`/`authorized`/`header(s)` helpers |
| `packages/server/src/cors.ts` | `CorsConfig` reference + `isAllowedCorsOrigin`/`isAllowedRequestOrigin` allowlist |
| `packages/server/src/handlers.ts` | `Layer.mergeAll` of all 18 handler groups |
| `packages/server/src/handlers/*.ts` | One `HttpApiBuilder.group` per Protocol group; SSE/WebSocket/binary endpoints use `handleRaw` |
| `packages/server/src/pty-environment.ts` | `PtyEnvironment` service stub (returns `{}` env) with a `makeGlobalNode` for host override |
| `packages/client/src/contract.ts` | `ClientApi` (client-local middleware markers), `groupNames`/`endpointNames`/`omitEndpoints` codegen options |
| `packages/client/script/build.ts` | `bun run generate`: compiles `ClientApi` and writes `src/generated` (Promise) + `src/generated-effect` (Effect) |
| `packages/client/src/index.ts` / `src/effect.ts` | Public entrypoints: zero-Effect Promise root; `/effect` re-exporting Schema datatypes |
| `packages/client/test/*.ts` | `contract-identity` (client/server generation equivalence), `import-boundaries` (browser bundle import graph), `effect`/`promise` behavior |
| `packages/httpapi-codegen/src/index.ts` | `compile`/`emitPromise`/`emitEffectImported`/`write`: HttpApi → generated client sources |
| `packages/sdk/js/script/build.ts` | Legacy SDK regeneration: `bun dev generate` → openapi.json patching → hey-api → staged swap into `src/v2/gen` |
| `packages/sdk/js/src/{client,server,error-interceptor,process}.ts` | Hand-written legacy SDK shell around generated code |
| `packages/sdk/js/src/v2/*` | Active `/v2` SDK surface (regenerated gen + location-rewrite client + spawner) |
| `packages/sdk-next/src/opencode.ts` | `OpenCode.create()`: embedded router as a `fetch`, client/effect on top, `tools.register` |
| `packages/cli/src/commands/handlers/serve.ts` | New CLI `serve`: V2-only routes, bind, port fallback, daemon password/registration |
| `packages/opencode/src/cli/cmd/serve.ts` | Legacy `opencode serve`: hosts `OpenCodeHttpApi`, prints the `opencode server listening` line the SDK parses |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts` | Legacy composition: `OpenCodeHttpApi` = root + event + instance + V2 `ServerApi` + PTY connect |
| `packages/opencode/src/server/routes/instance/httpapi/public.ts` | `PublicApi` OpenAPI compatibility transform (see `openapi-cleanup`) |
| `packages/opencode/src/cli/cmd/generate.ts` | `opencode generate`: prints PublicApi OpenAPI JSON (with code samples) to stdout |

## Package topology

Runtime dependency directions, verified from `package.json` files and enforced
by bundle tests (`packages/client/test/import-boundaries.test.ts`,
`packages/sdk-next/test/import-boundaries.test.ts`):

```text
@opencode-ai/schema  ──▶  @opencode-ai/core, @opencode-ai/protocol
@opencode-ai/core    ──▶  @opencode-ai/server        (server also deps core + protocol)
@opencode-ai/protocol ─▶ @opencode-ai/server
@opencode-ai/client  ──▶  schema + protocol only     (effect = optional peer dep)
@opencode-ai/sdk-next ─▶ client + core + server      (composes all three)
```

- The Promise root of `@opencode-ai/client` must bundle with **zero** inputs
  from `effect`, `schema`, `protocol`, `core`, or `server` (browser target).
- `@opencode-ai/client/effect` may bundle `effect`, `schema`, `protocol`, but
  never `core` or `server`; a TODO in `packages/client/src/effect.ts` keeps
  network capabilities inside Schema/Protocol as the client grows.
- `@opencode-ai/sdk-next` intentionally bundles client + core + server
  (asserted by its import-boundaries test).
- `@opencode-ai/protocol` depends only on `@opencode-ai/schema` + `effect`, so
  it is shareable by client, server, and the legacy `opencode` package.

Protocol owns endpoint construction and middleware *placement*; Server supplies
the concrete middleware keys (comment in `packages/protocol/src/api.ts`). This
is why `makeApi` is generic over `LocationId`/`SessionLocationId` context keys:
the client builds the same API with inert marker middlewares
(`packages/client/src/contract.ts`) while the server builds it with the real
providers, and both must compile to identical generated output.

## Protocol (`@opencode-ai/protocol`)

**File:** `packages/protocol/src/api.ts`.

- `makeApiFromGroup(eventGroup, locationMiddleware, sessionLocationMiddleware)`
  builds `HttpApi.make("server")` and adds all 18 groups:
  `server.health`, `server.location`, `server.agent`, `server.session`,
  `server.message`, `server.model`, `server.provider`,
  `server.integration`, `server.credential`, `server.permission`,
  `server.fs`, `server.command`, `server.skill`, `server.event`,
  `server.pty`, `server.question`, `server.reference`, `server.projectCopy`.
- `makeApi({definitions, ...})` builds the event group from a custom event
  definition list (used by the legacy server, which passes
  `EventManifest.Latest`); `makeDefaultApi(...)` uses
  `EventManifest.ServerDefinitions` from `@opencode-ai/schema/event-manifest`.
- API-level middleware, applied to every group: `Authorization` and
  `SchemaErrorMiddleware` (markers declared in
  `packages/protocol/src/middleware/`).
- Group-level middleware placement:
  - `server.session`, `server.message` — session-location middleware only
    (Location derived from the session row).
  - `server.permission`, `server.question` — both location and session-location
    middlewares (endpoints split between location-scoped `permission.list`-style
    and session-scoped `session.permission.*` routes).
  - `server.health`, `server.event` — no group middleware (process-global
    routes, not location-scoped).
  - everything else — location middleware.
- OpenAPI metadata: title "opencode HttpApi", version "0.0.1".

### Group conventions

**Files:** `packages/protocol/src/groups/*.ts`.

- Endpoint ids are `"domain.verb"` strings (`session.list`, `session.revert.stage`,
  `permission.request.list`); paths live under `/api/...`
  (`/api/session/:sessionID/message`).
- Every endpoint carries `OpenApi.annotations` with a stable `v2.*`
  identifier, summary, and description; these identifiers surface in generated
  SDK naming and docs.
- Location-scoped GET routes take `LocationQuery`
  (`location[directory]`, `location[workspace]`; both optional strings) and
  are annotated `locationQueryOpenApi` which rewrites the OpenAPI parameter to
  `style: "deepObject", explode: true` so generated clients send
  `location[directory]=...`.
- Location-scoped successes use `Location.response(Data)` from
  `packages/schema/src/location.ts` — the `{location: Location.Info, data}`
  envelope. Exceptions: `server.location` returns `Location.Info` itself, and
  the `server.session`/`server.message` groups return `{data}` without the
  envelope (session routes resolve location through the session itself).
- Query numbers/booleans use `Schema.NumberFromString` (+ `PositiveInt`/
  `NonNegativeInt` decodes) so the wire stays string-query while handlers
  receive decoded numbers.
- Opaque pagination: `SessionsCursor` (`groups/session.ts`) is a branded
  base64url JSON cursor carrying the query plus an anchor
  `{id, time, direction}`; invalid base64/JSON fails `SessionsCursor.parse`
  with `"Invalid cursor"`, mapped by the handler to `InvalidCursorError`.

### Event group and SSE

**File:** `packages/protocol/src/groups/event.ts`.

- `GET /api/event` (`event.subscribe`) declares
  `HttpApiSchema.StreamSse({data: EventSchema})`.
- `EventSchema` is a union of the provided event `Definition`s plus a
  synthesized `server.connected` struct when not already present, annotated
  `V2Event`. The default export `OpenCodeEvent` (type +
  `OpenCodeEventEncoded`) is the canonical event type reused by both clients
  and the SDK.

### Public errors

**File:** `packages/protocol/src/errors.ts`. All are
`Schema.TaggedErrorClass` with `httpApiStatus`:

| Error | Status | Notable fields |
|---|---|---|
| `InvalidRequestError` | 400 | `kind` (e.g. `Query`, `Payload`, `integration_authorization`), `field` |
| `UnauthorizedError` | 401 | — |
| `ForbiddenError` | 403 | — |
| `SessionNotFoundError`, `MessageNotFoundError`, `ProviderNotFoundError`, `PermissionNotFoundError`, `QuestionNotFoundError`, `PtyNotFoundError` | 404 | domain id fields |
| `ConflictError` | 409 | `resource` (durable prompt-id reuse) |
| `InvalidCursorError` | 400 | — |
| `ServiceUnavailableError` | 503 | `service` (e.g. `session.compact`) |
| `UnknownError` | 500 | `ref` (`err_<8 hex>`) correlating to server logs |

## Server (`@opencode-ai/server`)

### API binding and route assembly

**Files:** `packages/server/src/api.ts`, `packages/server/src/routes.ts`.

- `Api` binds `makeDefaultApi` to the real `LocationMiddleware` and
  `SessionLocationMiddleware`.
- `createRoutes(password?)`:
  - with a password — auth config `{username: "opencode", password: some}`;
  - without — `ServerAuth.Config.layer` reads
    `OPENCODE_SERVER_PASSWORD` (optional) and `OPENCODE_SERVER_USERNAME`
    (default `"opencode"`) from the environment.
- `createEmbeddedRoutes()` — password `none`, i.e. auth permanently disabled
  (used by sdk-next's in-process host).
- `makeRoutes` stacks, innermost-first: `handlers` (all 18 groups) →
  `sessionLocationLayer` → `locationLayer` → `authorizationLayer` →
  `schemaErrorLayer` → auth config → `serviceLayer`.
- `serviceLayer` is `AppNodeBuilder.build` over a `LayerNode.group` of
  application services (Database, EventV2, httpClient, ToolOutputStore
  cleanup, SessionV2, PermissionSaved, PtyTicket, Credential, PtyEnvironment,
  LocationServiceMap) with `SessionExecution.node` bound to
  `SessionExecutionLocal.node`.
- `HttpApiBuilder.layer(Api, {openapiPath: "/openapi.json"})` — the assembled
  API also serves its own OpenAPI document at `/openapi.json`.
- `webHandler()` converts the route layer (plus `HttpServer.layerServices`)
  into a `Request → Response` web-handler with logging disabled; this is the
  embedding seam used by sdk-next.

### Location model (instance selection)

**File:** `packages/server/src/location.ts`.

Per request, `LocationMiddleware` derives a `Location.Ref`:

- workspace: query `location[workspace]` → header `x-opencode-workspace` →
  absent;
- directory: query `location[directory]` → header `x-opencode-directory`
  (URI-decoded, decode failures pass through raw) → `process.cwd()`.

It then provides `LocationServiceMap.get(ref)` (the per-location service
bundle: filesystem, sessions, catalog, tools, permissions, …) to the handler.
`response(data)` wraps handler output as `{location: Location.Info, data}` so
clients learn the resolved directory/workspace/project.

**File:** `packages/server/src/middleware/session-location.ts`. Routes with a
`:sessionID` path param resolve Location from the database row
(`SessionTable.directory`, `SessionTable.workspace_id`) instead of the query:
an undecodable id → `InvalidRequestError` (field `sessionID`); a missing row →
`SessionNotFoundError`. This makes session routes location-addressable by
session id alone and immune to directory/query mismatch.

### Authorization

**Files:** `packages/server/src/auth.ts`, `packages/server/src/middleware/authorization.ts`,
`packages/protocol/src/groups/pty.ts`.

- Auth is active iff `OPENCODE_SERVER_PASSWORD` (or explicit config) is a
  non-empty string (`ServerAuth.required`).
- Credentials are accepted from:
  - `Authorization: Basic base64(user:pass)` header, or
  - `?auth_token=base64(user:pass)` query parameter (for WebSocket/browser
    clients that cannot set headers on upgrade).
- `Authorization` middleware (protocol marker; server layer in
  `middleware/authorization.ts`):
  - passes through unchanged when auth is not required;
  - skips credential checks for ticketed PTY connect URLs
    (`hasPtyConnectTicketURL`: path `/api/pty/:id/connect` with a `ticket`
    query param) — browsers cannot set headers on upgrades, so the connect
    handler consumes/validates the ticket itself;
  - on failure appends `www-authenticate: Basic realm="Secure Area"` and fails
    with `UnauthorizedError`.

### Schema rejections

**File:** `packages/server/src/middleware/schema-error.ts`. HttpApi request
decoding failures are transformed into `InvalidRequestError` with the rejection
`kind` and a reason truncated to 1024 chars (`... (N more chars)` suffix); the
full reason is logged as a warning with `{kind, reason}` annotations. This
keeps the public 400 body a declared schema contract (per `effect-routes`).

### CORS

**File:** `packages/server/src/cors.ts`. `CorsConfig` is an Effect
`Context.Reference` (default undefined) read by the PTY handlers. Allowed
origins without configuration: no origin, `http://localhost:*`,
`http://127.0.0.1:*`, `oc://renderer` (desktop), `tauri://localhost`
variants, and `*.opencode.ai`; otherwise the configured `cors` array.
`isAllowedRequestOrigin` additionally accepts same-host origins.

### Handler inventory

**Files:** `packages/server/src/handlers/*.ts` (merged in `handlers.ts`).
All follow `effect-routes`: stable services yielded once while building the
group; domain errors `Effect.catchTag`-mapped to declared public errors at the
boundary; unexpected defects become `UnknownError` with an `err_` ref after
logging.

| Handler file | Group | Backing services | Notable behavior |
|---|---|---|---|
| `health.ts` | `server.health` | — | `GET /api/health` → `{healthy: true}` |
| `location.ts` | `server.location` | `Location.Service` | resolves and returns `Location.Info` |
| `agent.ts` | `server.agent` | `AgentV2` | `GET /api/agent` |
| `session.ts` | `server.session` | `SessionV2` | 17 endpoints: list (cursor pagination, defaults limit 50), create (location defaults to `process.cwd()`), active, get/switchAgent/switchModel, prompt (ConflictError on durable id reuse), compact/wait (ServiceUnavailableError while unimplemented), revert stage/clear/commit, context, history (limit ≤ 100), events (SSE stream), interrupt, message |
| `message.ts` | `server.message` | `SessionV2`, `SessionMessage` | `session.messages` list with base64url `{id, order, direction}` cursor; cursor+order mutual exclusion → `InvalidCursorError` |
| `model.ts` / `provider.ts` | `server.model` / `server.provider` | `Catalog` | available models/providers; `provider.get` → `ProviderNotFoundError` |
| `integration.ts` / `credential.ts` | `server.integration` / `server.credential` | `Integration` | OAuth/key connect flows; authorization failures → `InvalidRequestError` with `kind: "integration_authorization"` |
| `permission.ts` | `server.permission` | `PermissionV2`, `PermissionSaved` | ask/list/reply for requests; saved-permission list/remove |
| `question.ts` | `server.question` | `QuestionV2` | reply/reject with session-ownership check → `QuestionNotFoundError` |
| `fs.ts` | `server.fs` | `FileSystem` | `fs.read` is `handleRaw` binary (strips the 13-char `/api/fs/read/` prefix, decodes URI, serves bytes with mime); list/find use the envelope |
| `command.ts` / `skill.ts` / `reference.ts` | same-named | `CommandV2`/`SkillV2`/`Reference` | single list endpoint each |
| `event.ts` | `server.event` | `EventV2` | SSE, see below |
| `pty.ts` | `server.pty` | `Pty`, `PtyTicket`, `PtyEnvironment` | list/create/get/update/remove + `connect-token` + WebSocket `connect`, see below |
| `project-copy.ts` | `server.projectCopy` | `ProjectCopy`, `Git` | create/remove/refresh project copies; domain failures → group-local `ProjectCopyError` |

`PtyEnvironment` (`packages/server/src/pty-environment.ts`) is a stub: its
`get` returns `{}`, injected into PTY create env; hosts may override the
global node.

### Transports actually present

1. **HTTP JSON** — the default `HttpApiBuilder` path; `HttpApiSchema.NoContent`
   endpoints return 204 with empty bodies.
2. **Binary body** — `fs.read` via `handleRaw` returns
   `HttpServerResponse.uint8Array` with the file's mime type.
3. **SSE** — `GET /api/event` (`event.ts`):
   - `handleRaw` builds a `text/event-stream` response with
     `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`,
     `X-Content-Type-Options: nosniff`;
   - the first emitted event is a synthetic `server.connected` (fresh
     `EventV2.ID`), then the live bounded stream (subscriber capacity 256,
     acquired before readiness is observable so no early event is lost);
   - events are JSON-encoded via `OpenCodeEvent` and framed with
     `event: message`;
   - a 15-second `: heartbeat\n\n` comment stream is merged (halts when the
     event stream halts).
4. **WebSocket** — `GET /api/pty/:ptyID/connect` (`pty.ts`, `handleRaw`):
   - existence check first (empty 404 before any upgrade work — query fields
     are intentionally decoded after this check);
   - ticket flow: `POST /api/pty/:id/connect-token` issues a short-lived
     single-use ticket, but only when the request carries
     `x-opencode-ticket: 1` (forcing a CORS preflight) and passes the origin
     policy; the connect handler consumes the ticket (403 on invalid/foreign
     origin);
   - replay: `cursor` query (integer ≥ -1) bounds replayed output; replay
     chunks, then a meta frame with the new cursor, then live output flow
     through one unbounded outbox queue drained by a single writer so
     ordering is preserved; PTY end → close frame 1000; missing/exited
     session after upgrade → close 4404 with reason;
   - input frames are decoded by `PtyProtocol.decodeInput`; socket errors
     end the race and detach the attachment.
   - `x-websocket: true` plus synthetic string query parameters are injected
     via the endpoint's OpenAPI `transform` so docs/SDK describe the upgrade.

There is deliberately no WebSocket transport for events (SSE only) and no
other push channel in the V2 server.

## Hosting and lifecycle

Two `serve` entrypoints coexist:

### `opencode serve` (legacy CLI, shipped binary)

**File:** `packages/opencode/src/cli/cmd/serve.ts`.

- Hosts the legacy `Server.listen` (the `OpenCodeHttpApi` composition below)
  with network options from flags; `instance: false` — the server loads
  instances per request via the directory header, so no ambient project
  context is needed at startup.
- Warns when `OPENCODE_SERVER_PASSWORD` is not set ("server is unsecured").
- Prints `opencode server listening on http://<host>:<port>` — the exact
  prefix+URL the legacy SDK spawner parses — then blocks (`Effect.never`).

### `serve` (new CLI package, V2-only)

**File:** `packages/cli/src/commands/handlers/serve.ts`.

- Serves `createRoutes(password)` from `@opencode-ai/server` (the pure V2
  API) via `HttpRouter.serve` on a Node HTTP server.
- Password comes from the CLI Daemon service (persisted password file; also
  exposed via `ServerAuth.headers` for daemon clients).
- Port binding: explicit port, or fallback scanning 4096 → 65535 on bind
  failure.
- `--register` publishes the address with the daemon.
- Prints `server listening on <url>` (no `opencode` prefix — the legacy SDK
  spawner does not parse this entrypoint) and blocks inside a scope.

### Embedded host (sdk-next)

**File:** `packages/sdk-next/src/opencode.ts`. See
[sdk-next](#sdk-next-opencode-ai-sdk-next).

### Legacy hosting internals

**File:** `packages/opencode/src/server/server.ts`. The `opencode` package
hosts `OpenCodeHttpApi` (legacy + V2 composition, below) with
`HttpRouter.serve`, port fallback 4096-then-0 for `--port=0`, optional mDNS
publish, a WebSocket tracker for graceful shutdown, and a per-listener
`ConfigProvider` refresh. `Server.openapi()` renders `PublicApi`. This is the
host reached by `opencode serve` in the shipped CLI *and* by the legacy SDK
spawner; the V2-only `packages/server` routes are reachable through it as a
sub-API.

## Legacy composition: how V2 routes reach the shipped server and SDK

**File:** `packages/opencode/src/server/routes/instance/httpapi/api.ts`.

```text
OpenCodeHttpApi ("opencode")
├── RootHttpApi        (control, control-plane, global)  + SchemaError + Authorization
├── EventApi           (legacy /event SSE)
├── InstanceHttpApi    (legacy /session, /config, /file, /pty, …) + SchemaError
├── ServerApi          = protocol makeApi(EventManifest.Latest, server middlewares)  ← the /api/* V2 surface
└── PtyConnectApi      (ticketed WS connect)
```

- The V2 groups from `packages/protocol` are mounted unchanged next to legacy
  groups; `LocationMiddleware`/`SessionLocationMiddleware` come from
  `@opencode-ai/server`.
- `PublicApi` (`public.ts`) wraps `OpenCodeHttpApi` with the legacy OpenAPI
  compatibility `transform` — component renaming, optional-null stripping,
  error-shape normalization, query-type overrides, SSE response schemas for
  `/event`, `/global/event`, `/api/event`, and auth-metadata deletion for
  non-V2 paths. Contents and the shrink plan are owned by `openapi-cleanup`;
  drift between the transform and runtime schemas is policed by
  `packages/opencode/test/server/httpapi-query-schema-drift.test.ts`.

**File:** `packages/opencode/src/cli/cmd/generate.ts`. `opencode generate`
(and `bun dev generate` from the package dir) renders `OpenApi.fromApi(PublicApi)`,
injects `x-codeSamples` JS snippets per operation, prettier-formats, and
writes the JSON to **stdout**. The legacy SDK build captures this output.

## Client (`@opencode-ai/client`)

**File:** `packages/client/README.md` (contract summary), `src/contract.ts`,
`script/build.ts`.

- Private generation target; not published. Two entrypoints:
  - `@opencode-ai/client` — zero-Effect Promise client over `fetch`;
  - `@opencode-ai/client/effect` — Effect client over an environment
    `HttpClient` (`effect` is an optional peer dependency, pinned to the
    catalog beta).
- `src/contract.ts` rebuilds the API with client-local inert middleware
  markers (same ids pattern, no `provides`) and renames for ergonomics:
  - `groupNames`: `server.session` → `sessions`, `server.fs` → `files`, …;
  - `endpointNames`: `session.messages` → `list`,
    `integration.connect.oauth` → `connectOauth`, …;
  - `omitEndpoints`: `fs.read` (raw binary path), `pty.connect` (WebSocket),
    `pty.connectToken` (ticketed) — custom transports stay outside the
    generic HTTP client.
- `test/contract-identity.test.ts` asserts the client and Server contracts
  compile to **identical** generated output (`compile(Api)` vs
  `compile(ClientApi)` with the same options) and that Core re-exports the
  same schema values (`SessionV2.Info === Session.Info` etc.), preventing
  transport drift between the two API constructions.

### Generation

- `bun run generate` (from `packages/client`) runs `script/build.ts`:
  `compile(ClientApi, {groupNames, endpointNames, omitEndpoints})` then
  `emitPromise` → `src/generated` and `emitEffectImported` →
  `src/generated-effect`, formatted via prettier inside
  `@opencode-ai/httpapi-codegen`.
- `src/generated`/`src/generated-effect` are committed but **never edited by
  hand** (AGENTS.md); `bun run check:generated` regenerates and fails on any
  diff (`git diff --exit-code -- src/generated src/generated-effect`).
- After changing the public Protocol or Server `HttpApi`, regenerate from
  `packages/client` (AGENTS.md).

### Generated Promise client

**Files:** `src/generated/client.ts`, `src/generated/types.ts`,
`src/generated/client-error.ts`.

- Shape: `OpenCode.make({baseUrl, fetch?, headers?})` →
  `client.sessions.list(input?, requestOptions?)` returning promises of the
  encoded (wire) types; `types.ts` holds input/output type pairs.
- Request building: URL join against `baseUrl`, query serialization
  (deepObject for `location`), header merging (client headers → per-call
  headers), automatic `content-type: application/json` when a body exists.
- Responses: the declared success status is decoded as JSON (`empty`
  descriptors return `undefined`); a declared error status throws the decoded
  error body as-is; anything else throws `ClientError("UnexpectedStatus")`.
- `ClientError` reasons: `Transport` (fetch failure), `UnexpectedStatus`,
  `UnsupportedContentType` (SSE endpoint answered non-`text/event-stream`),
  `MalformedResponse` (bad JSON, missing body, SSE buffer > 1 MiB).
- SSE (`events.subscribe`): returns an `AsyncIterable<EventsSubscribeOutput>`
  where `EventsSubscribeOutput = OpenCodeEventEncoded` (imported from
  `@opencode-ai/protocol/groups/event` — the one type the generator is told to
  import rather than emit); the parser normalizes CRLF, splits on `\n\n`,
  joins multi-line `data:` fields.
- `src/index.ts` re-exports the generated surface and aliases
  `EventsSubscribeOutput` as `OpenCodeEvent`.

### Generated Effect client

**Files:** `src/generated-effect/client.ts`, `src/generated-effect/client-error.ts`.

- Built on `HttpApiClient.ForApi<typeof ClientApi>` (from `../contract`), so
  decoding uses the real Protocol schemas and returns canonical decoded
  values (`Session.ID`, `Location.Ref`, `Prompt`, …).
- Each endpoint adapter flattens `{params, query, payload}` into one input
  object, unwraps `{data}` envelopes, and maps transport-level failures
  (`HttpClientError`, schema errors, `Sse.Retry`) into a tagged
  `ClientError`; declared API errors flow through unchanged as typed failures.
- `events.subscribe` / `session.events` surface as `Stream`s
  (`Stream.unwrap` over the raw SSE stream).
- `src/effect.ts` re-exports Schema datatypes (`Session`, `Prompt`,
  `AbsolutePath`, …) and `OpenCodeEvent` so callers depend only on the client
  surface; it must never import Core or Server (TODO comment + boundary
  test).

## Code generator (`@opencode-ai/httpapi-codegen`)

**File:** `packages/httpapi-codegen/src/index.ts`.

- `compile(api, options)` walks `HttpApi.reflect`:
  - omits `omitEndpoints` entries; applies group/endpoint renames;
  - refuses to generate endpoints whose middleware is `requiredForClient`
    (client adapters must not exist for them) — this is the mechanism that
    would exclude a future mandatory middleware;
  - classifies success as `value`/`void`/`stream`, records input fields
    (params/query/headers/payload) with optionality, declared error names and
    statuses; rejects multiple success schemas.
- `emitPromise(contract, {outputTypes})` emits the fetch client
  (overridable output types such as the imported event type);
  `emitEffectImported(contract, {module, api})` emits the Effect adapter that
  imports the contract for `HttpApiClient`; `write` performs the filesystem
  emit. Output is prettier-formatted.

## Legacy JavaScript SDK (`@opencode-ai/sdk`)

**Files:** `packages/sdk/js/` (published; version tracks the monorepo,
`files: ["dist"]`, `script/publish.ts` rewrites `exports` to `dist` paths).

### Entrypoints

- **Root (`@opencode-ai/sdk`)** — the frozen legacy surface:
  - `src/gen/*` is generated output from the retired V1 spec (paths
    `/session`, `/config`, `/project`, `/global/*`, …); it is formatted by the
    build but **not regenerated** — history shows it frozen while `src/v2/gen`
    tracks every API change.
  - `src/client.ts` (`createOpencodeClient`): wraps the hey-api fetch client;
    sets `x-opencode-directory` from `config.directory`; a request interceptor
    rewrites that header into a `directory` query param on GET/HEAD (header
    wins over config unless equal/encoded-equal); disables hey-api timeouts;
    `wrapClientError` error interceptor.
  - `src/server.ts`: `createOpencodeServer` spawns `opencode serve` via
    cross-spawn (config passed as `OPENCODE_CONFIG_CONTENT` env), resolves the
    URL by parsing the `opencode server listening on <url>` stdout line, with
    timeout/abort handling; `createOpencodeTui` spawns the TUI; `createOpencode`
    bundles server + client.
  - `src/process.ts`: process stop (Windows `taskkill /T /F`) and AbortSignal
    binding; duplicated from `packages/opencode` to avoid a dependency cycle.
  - `src/error-interceptor.ts`: only with `{throwOnError: true}`, wraps
    decoded non-Error bodies into real `Error`s (message from
    `data.message`/`message`/`name`, original body+status under `cause`).
- **`@opencode-ai/sdk/v2`** — the active surface:
  - `src/v2/gen/*` is regenerated on every API change (below); contains both
    legacy routes and the 58 `/api/*` V2 operations.
  - `src/v2/client.ts`: like the root client but also handles
    `x-opencode-workspace` / `experimental_workspaceID`, mirrors headers into
    both `directory` and `location[directory]` query forms for `/api/*`
    routes, and rejects `text/html` responses with an explicit
    "not supported by this version of OpenCode Server" error.
  - `src/v2/server.ts`: same spawner as root. `src/v2/data.ts` adds
    message/part construction helpers. `src/v2/index.ts` re-exports client,
    server, and `data`.

### Regeneration pipeline

**File:** `packages/sdk/js/script/build.ts` (run as
`./packages/sdk/js/script/build.ts` from repo root, per AGENTS.md):

1. `bun dev generate` inside `packages/opencode` → captures the PublicApi
   OpenAPI JSON into `packages/sdk/js/openapi.json`.
2. Prunes unreachable `SessionNext*1` duplicate components (reachable-set
   walk over `$ref`s).
3. `@hey-api/openapi-ts` generates into a **staging** directory
   (`tmp/gen-staging`) — never directly into `src/v2/gen`, because hey-api's
   `clean: true` would leave a window where concurrent package builds cannot
   resolve the gen files.
4. Patches generated output (each patch fails the build if it does not
   apply):
   - `V2SessionHistoryData`/SDK `limit`/`after` query types `string` →
     `number` (SDK callers pass numbers; server decodes string query);
   - hey-api SSE generic bug: drop the erroneous `TError` second type
     argument of `ServerSentEventsResult`.
5. Prettier over `src/gen src/v2 staging`; atomic swap `staging` →
   `src/v2/gen`; `tsc` build to `dist`.

Invariant: `/doc`, generated SDK types, and runtime validation must agree for
every endpoint (`openapi-cleanup` non-negotiable); the query-drift test in
`packages/opencode` guards the OpenAPI side, `check:generated` guards the
client side.

## sdk-next (`@opencode-ai/sdk-next`)

**Files:** `packages/sdk-next/README.md`, `src/opencode.ts`, `src/tool.ts`,
`src/index.ts`, `test/embedded.test.ts`, `test/import-boundaries.test.ts`.

- Transitional Effect-native host intended to replace the generated
  `@opencode-ai/sdk` after consumer migration; private, composes Client +
  Core + Server (the only package allowed all three).
- `OpenCode.create()` (Effect, scope-bound):
  1. builds `ApplicationTools` + `PermissionSaved` nodes with a fresh memo map
     in the current Scope;
  2. acquires `HttpRouter.toWebHandler(createEmbeddedRoutes() …)` — the real
     V2 router, handlers, codecs, middleware (auth disabled) — released
     (`web.dispose`) with the scope;
  3. bridges the web handler as a `fetch` implementation and constructs the
     generated Effect client (`OpenCode.make({baseUrl: "http://opencode.local"})`
     with `FetchHttpClient.layer`); no listener, no network I/O;
  4. exposes the client surface plus `tools.register` (Core's host-level
     `ApplicationTools`; each Location keeps its own `ToolRegistry`).
- `OpenCode.layer` adapts `create()` for dependency injection; it is not a
  second implementation.
- `Tool` re-exports Core's tool `make`/`Failure`/`RegistrationError` and
  types, replacing the former `@opencode-ai/core/public` facade.
- `src/index.ts` re-exports the client's datatype surface (`Session`,
  `Prompt`, `Location`, …, `OpenCodeEvent`, `ClientError`) so consumers need
  only this package.
- `sessions.events({sessionID, after})` replays durable events after the
  optional sequence then streams newly committed ones; `sessions.interrupt`
  targets execution owned by this host; closing the Scope releases router
  resources, location services, fibers, and scoped tool registrations
  (verified end-to-end by `test/embedded.test.ts`, which runs real sessions
  against the embedded router).

## Invariants and constraints

1. **Dependency direction** (AGENTS.md): Schema → Core/Protocol → Server;
   client runtime may depend on Schema + Protocol, never Core/Server;
   sdk-next composes all three. Enforced by bundle-boundary tests, not just
   review.
2. **Generated code is never hand-edited**: `packages/client/src/generated*`
   (regenerate with `bun run generate` from `packages/client`) and
   `packages/sdk/js/src/v2/gen` (regenerate with
   `./packages/sdk/js/script/build.ts` from repo root).
3. **Client/server contract identity**: `ClientApi` and Server's `Api` must
   compile to identical output; `contract-identity.test.ts` fails otherwise.
4. **Protocol owns placement, hosts own keys**: middleware classes with
   `provides` live in (or are injected by) the host; protocol/group files
   reference only marker types or host-injected context keys. Server injects
   real keys; client injects inert markers; the legacy opencode server
   injects the server keys via `makeApi`.
5. **Runtime schemas are the source of truth** for accepted params/payloads
   (`openapi-cleanup`); the OpenAPI transform must not advertise what runtime
   validation rejects.
6. **Error mapping at the boundary**: handlers translate tagged service
   errors into protocol errors; middleware does not become a domain-error
   mapper (`effect-routes`). Unexpected defects → `UnknownError` + `ref`.
7. **Auth is optional-but-uniform**: one Basic realm; query `auth_token`
   equivalence; PTY connect is the only credential-exempt path and only with
   a consumable ticket.
8. **Embedded routes are auth-free by construction** (`createEmbeddedRoutes`)
   — hosts embedding the router in-process take responsibility for access.
9. **Legacy SDK stability**: `/v2` gen may only change intentionally; the
   build's hard-failing patches (numeric query, SSE generic, component
   pruning) double as canaries for upstream hey-api/Effect output changes.

## Divergences and open questions

- `effect-server-package.md` (draft) describes the split as future work and
  warns against `packages/server` importing `packages/opencode`; the realized
  tree satisfies the rule (server deps: core + protocol only), and the legacy
  `opencode` package now *consumes* `@opencode-ai/server` middlewares to mount
  the V2 API — the extraction effectively happened, with `packages/server`
  owning contracts + handlers and `packages/opencode` owning legacy hosting.
  The draft's "Current State" section is stale.
- AGENTS.md says SDK regeneration is `./packages/sdk/js/script/build.ts`; it
  also (correctly) notes `bun run generate` from `packages/client` for the
  private client. Two distinct generation flows exist and both must run after
  Protocol/Server HttpApi changes: the client check guards transport drift,
  the SDK build guards the published surface.
- `routes.md` scopes itself to
  `packages/opencode/src/server/routes/instance/httpapi` (legacy tree); the
  newer `packages/server/src/handlers` follows the same conventions but is
  formally outside that document's stated path scope.
- `openapi-cleanup` PR 3+ items (query overrides, path patterns, error
  rewrites, auth deletion, component shape) are still open in `public.ts`;
  this spec records their presence, not their removal.
- Open questions:
  - Will `event.subscribe` grow a replay/`after` parameter at the global
    level (session-scoped `session.events` already has one), or remains
    live-only with `server.connected` as the sole synthetic event?
  - Should `PtyEnvironment` remain a stub, or do hosts (desktop/CLI) plan to
    override it with real environment injection?
  - The `x-websocket` OpenAPI extension and injected string query params on
    `pty.connect` are spec-only descriptions of a raw handler — the same
    spec/runtime drift risk class that `openapi-cleanup` is eliminating
    elsewhere; no drift test covers them.
  - sdk-next README calls the package transitional; migration ownership
    (who moves `@opencode-ai/sdk` consumers, and when the legacy SDK freezes)
    is not recorded anywhere.
