import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ConfigProviderV1 } from "@opencode-ai/core/v1/config/provider"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, Effect, Layer, Schema } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LanguageModelV3Middleware } from "@ai-sdk/provider"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"

export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

/**
 * Middleware that lowers ModelMessages into the provider prompt shape via
 * `ProviderTransform.message`, exactly as the battle path does inside
 * `streamText`. Shared by `run` and `captureBody` so a captured request gets
 * the same prompt transform as a live stream.
 */
function messageTransformMiddleware(model: Provider.Model, options: Record<string, any>): LanguageModelV3Middleware {
  return {
    specificationVersion: "v3",
    async transformParams({ params, type }) {
      if (type === "stream") {
        // @ts-expect-error ProviderTransform.message lowers ModelMessages into
        // the runtime provider prompt shape; the declared parameter types lag.
        params.prompt = ProviderTransform.message(params.prompt, model, options)
      }
      return params
    },
  }
}

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

/**
 * Raised when the request body of a stream input cannot be captured.
 *
 * `reason` describes the failure stage; `cause` carries the underlying
 * provider error when one exists. This is a pure dry-run error: it never
 * touches the session state and no network request was sent when it fails.
 */
export class CaptureError extends Schema.TaggedErrorClass<CaptureError>()("LLMCaptureError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.reason
  }
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
  /**
   * Rebuilds the exact provider request body for `input` without contacting
   * the provider and without touching session state (pure dry-run).
   *
   * The input goes through the same preparation (`LLMRequestPrep.prepare`)
   * and the same streamText argument assembly as `stream`, but the language
   * model comes from `Provider.getCaptureLanguage`, whose fetch aborts as soon
   * as the provider SDK has serialized the request. Returns that serialized
   * body — byte-for-byte the string the battle path would pass to fetch as
   * `init.body`.
   *
   * Accuracy caveat: the body reproduces the request under the CURRENT
   * session/config/plugin state. If config, plugins, agent instructions, or
   * session history changed since the original turn, the dump differs from
   * what was actually sent.
   *
   * Errors: CaptureError — provider/model resolution failed, the model routes
   * over a non-fetch transport (workflow models), or the provider never
   * serialized a request body.
   */
  readonly captureBody: (input: StreamInput) => Effect.Effect<string, CaptureError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      // Prime-time gate: refuse before any provider resolution or network work.
      // By default the error surfaces to the session processor as a terminal
      // message error; with `primeTimeRetry` it is a retryable APIError whose
      // synthetic retry-after schedules the attempt at the window end.
      if (ConfigProviderV1.primeTimeActive(input.model)) {
        const message = `Model ${input.model.providerID}/${input.model.id} is in prime-time (${input.model.primeTimeStart}–${input.model.primeTimeEnd} on ${(input.model.primeTimeDay ?? []).join(", ")}) and cannot be used.`
        yield* Effect.logInfo("model blocked by prime-time", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          primeTimeStart: input.model.primeTimeStart,
          primeTimeEnd: input.model.primeTimeEnd,
          primeTimeRetry: input.model.primeTimeRetry,
        })
        if (!input.model.primeTimeRetry) {
          return yield* Effect.fail(new Error(message))
        }
        const windowEnd = ConfigProviderV1.primeTimeWindowEnd(input.model)
        return yield* Effect.fail(
          new SessionV1.APIError({
            message,
            isRetryable: true,
            // A window that never ends (every second of listed days) omits the
            // hint; standard backoff then exhausts the retry budget into the
            // terminal error.
            responseHeaders:
              windowEnd === undefined ? undefined : { "retry-after-ms": String(windowEnd - Date.now()) },
          }),
        )
      }

      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      const bridge = yield* EffectBridge.make()
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listen((event) => {
                if (event.type !== Permission.Event.Replied.type) return Effect.void
                const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @opencode-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      if (flags.experimentalNativeLlm) {
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "native",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          return {
            type: "native" as const,
            stream: native.stream,
          }
        }
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
          "llm.native_unsupported_reason": native.reason,
        })
        yield* Effect.logInfo("native runtime unavailable; falling back to ai-sdk", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          small: (input.small ?? false).toString(),
          agent: input.agent.name,
          mode: input.agent.mode,
          reason: native.reason,
        })
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
      })
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      return {
        type: "ai-sdk" as const,
        result: streamText({
          onError(error) {
            bridge.fork(
              Effect.logError("stream error", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                "session.id": input.sessionID,
                small: (input.small ?? false).toString(),
                agent: input.agent.name,
                mode: input.agent.mode,
                error,
              }),
            )
          },
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks: input.model.providerID.includes("github-copilot"),
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          messages: prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [messageTransformMiddleware(input.model, prepared.messageTransformOptions)],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const captureBody = Effect.fn("LLM.captureBody")(function* (input: StreamInput) {
      const [item, info, capture] = yield* Effect.all(
        [
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
          provider.getCaptureLanguage(input.model),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.catch((cause) => new CaptureError({ reason: "provider resolution failed", cause })))

      // Workflow models dispatch over the LLM WebSocket transport instead of
      // an HTTP fetch, so the capture transport can never see their body.
      if (capture.language instanceof GitLabWorkflowLanguageModel) {
        return yield* new CaptureError({
          reason: "workflow models route over the LLM WebSocket transport and cannot be captured",
        })
      }

      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow: false,
      }).pipe(Effect.catch((cause) => new CaptureError({ reason: "request preparation failed", cause })))

      // Same argument assembly as the battle streamText call below, minus
      // response-side concerns that cannot affect the outgoing body (error
      // logging, tool-call repair, telemetry, raw chunks). The capture fetch
      // throws as soon as the provider SDK serializes the request, so the
      // stream always ends in an error part and never touches the network.
      const controller = new AbortController()
      const failure = yield* Effect.tryPromise({
        try: async () => {
          let error: unknown
          const result = streamText({
            temperature: prepared.params.temperature,
            topP: prepared.params.topP,
            topK: prepared.params.topK,
            providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
            activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
            tools: prepared.tools,
            toolChoice: input.toolChoice,
            maxOutputTokens: prepared.params.maxOutputTokens,
            abortSignal: controller.signal,
            headers: prepared.headers,
            maxRetries: 0,
            messages: prepared.messages,
            model: wrapLanguageModel({
              model: capture.language,
              middleware: [messageTransformMiddleware(input.model, prepared.messageTransformOptions)],
            }),
          })
          for await (const part of result.fullStream) {
            if (part.type === "error") error = part.error
          }
          return error
        },
        catch: (cause) => new CaptureError({ reason: "capture stream failed", cause }),
      })

      const body = capture.takeBody()
      if (body === undefined) {
        return yield* new CaptureError({
          reason: "the provider never serialized a request body",
          cause: failure,
        })
      }
      return body
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })

            if (result.type === "native") return result.stream

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState()
            return Stream.fromAsyncIterable(result.result.fullStream, (e) =>
              e instanceof Error ? e : new Error(String(e)),
            ).pipe(
              Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            )
          }),
        ),
      )

    return Service.of({ stream, captureBody })
  }),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export const node = LayerNode.make({
  service: Service,
  layer: live,
  deps: [
    Auth.node,
    Config.node,
    Provider.node,
    Plugin.node,
    Permission.node,
    EventV2Bridge.node,
    llmClient,
    RuntimeFlags.node,
  ],
})

export * as LLM from "./llm"
