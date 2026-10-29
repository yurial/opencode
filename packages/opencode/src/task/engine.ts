export * as TaskEngine from "./engine"

import { Context, Effect, Layer, Scope } from "effect"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { TaskRun } from "@opencode-ai/core/task-run/task-run"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import type { SessionPrompt } from "@/session/prompt"
import type { TaskPromptOps } from "@/tool/task"

/**
 * Escaping contract of the result and snapshot grammars (specs/tool-task.md
 * Result grammar, Status snapshot grammar): the model parses these blocks by
 * their tags, and the interpolated fields carry untrusted text — the run
 * description comes from the calling model, and the result text from the
 * subagent's output. Attribute values escape `&`, `<`, `>`, and `"` — a raw
 * quote would close the attribute and let the description forge attributes or
 * elements. Text bodies neutralize `</task` case-insensitively — a raw one
 * would close the task element early and let child output forge the
 * completion boundary.
 */
const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

const escapeText = (value: string) => value.replaceAll(/<\/task/gi, "&lt;/task")

/**
 * The result grammar of a launch result and of a blocking settlement result
 * (specs/tool-task.md Result grammar): one `<task>` element carrying the run
 * id and the state, an optional summary, and the final or failure text.
 */
export const renderOutput = (input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) => {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${escapeAttribute(input.sessionID)}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${escapeText(input.summary)}</summary>`] : []),
    `<${tag}>`,
    escapeText(input.text),
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

/**
 * The status snapshot of one subagent-run (specs/tool-task.md Status snapshot
 * grammar): the run id, the stored or derived state, the description, and the
 * launch instant plus the settle instant when the run left `running` — UTC
 * ISO 8601 instants.
 */
export const renderSnapshot = (row: {
  id: SessionID
  state: TaskRun.State
  description: string
  createdAt: number
  settledAt: number | null
}) =>
  [
    `<task id="${escapeAttribute(row.id)}" state="${row.state}" description="${escapeAttribute(row.description)}">`,
    row.settledAt === null
      ? `launched ${new Date(row.createdAt).toISOString()}`
      : `launched ${new Date(row.createdAt).toISOString()}, settled ${new Date(row.settledAt).toISOString()}`,
    `</task>`,
  ].join("\n")

/**
 * The shared mechanics of the task tool and the session.task.continue
 * endpoint (specs/tool-task.md R5.7, J10 — one liveness decision tree serves
 * both surfaces):
 *
 * - `address` is the `task_id` + prompt call: a live job receives the prompt
 *   as additional input (R1.6); a run with no live job has its registry row
 *   re-marked `running` before the prompt is admitted into the durable
 *   subagent session (R1.7, R4.4). Both branches return the running state of
 *   the same run id and hand completion ownership to `watch` (R2.4).
 * - `watch` is the exactly-once completion watcher: it waits for the run's
 *   job to settle, writes the settle state with the settle time before
 *   delivering anything (R4.5, R4.6, I4), and admits exactly one synthetic
 *   completion message into the parent session (R2.1, R2.4) — a cancelled
 *   run writes the row and delivers no message (R2.5).
 *
 * The engine takes the prompt admission capability (`TaskPromptOps`) as a
 * per-call argument instead of a dependency: the V1 prompt path depends on
 * the tool registry, which registers the task tool, so an engine dependency
 * edge here would close a layer cycle (the scheduler solves the same
 * topology with `attachV1Prompt`, specs/scheduler.md I4).
 */
export interface Interface {
  readonly address: (input: {
    readonly ops: TaskPromptOps
    readonly parentSession: SessionID
    readonly variant: string | undefined
    readonly runID: SessionID
    readonly description: string
    readonly agentName: string
    readonly model: SessionPrompt.PromptInput["model"]
    readonly useAgentModel: boolean
    readonly metadata: Record<string, unknown>
    readonly prompt: string
  }) => Effect.Effect<"extended" | "continued">
  readonly watch: (input: {
    readonly ops: TaskPromptOps
    readonly parentSession: SessionID
    readonly variant: string | undefined
    readonly runID: SessionID
    readonly description: string
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TaskEngine") {}

/**
 * Runs one child turn of a subagent session through the ordinary prompt
 * admission (`ops.prompt` — the same prompt ops as the launch, I6) and
 * returns the final text, failing with the child's failure text. The child's
 * durable session history is the conversation context of the turn.
 */
export const runChild = Effect.fn("TaskEngine.runChild")(function* (input: {
  ops: TaskPromptOps
  sessionID: SessionID
  agentName: string
  model: SessionPrompt.PromptInput["model"]
  useAgentModel: boolean
  variant: string | undefined
  prompt: string
}) {
  const parts = yield* input.ops.resolvePromptParts(input.prompt)
  const result = yield* input.ops.prompt({
    messageID: MessageID.ascending(),
    sessionID: input.sessionID,
    model: input.model ? { modelID: input.model.modelID, providerID: input.model.providerID } : undefined,
    variant: input.useAgentModel ? undefined : input.variant,
    agent: input.agentName,
    parts,
  })
  if (result.info.role === "assistant" && result.info.error) {
    const message =
      "message" in result.info.error.data && typeof result.info.error.data.message === "string"
        ? result.info.error.data.message
        : result.info.error.name
    return yield* Effect.fail(new Error(`Subagent failed (task_id: ${input.sessionID}): ${message}`))
  }
  const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
  if (failed?.type === "tool" && failed.state.status === "error") {
    return yield* Effect.fail(new Error(`Subagent failed (task_id: ${input.sessionID}): ${failed.state.error}`))
  }
  return result.parts.findLast((item) => item.type === "text")?.text ?? ""
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const registry = yield* TaskRun.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope

    // Per-run serialization of the continuation decision (R1.7): two
    // concurrent task_id+prompt calls must not both read "no live job" — the
    // second background.start would no-op on the first's running job and
    // silently drop its prompt. The same lock serializes a finishing
    // watcher's settle-and-deliver section against a continuation's
    // re-mark-and-start: an old watcher can neither overwrite a re-marked
    // running row nor have its registration removed while a newer watcher
    // attaches, because the cooperative scheduler runs each lock holder
    // atomically once entered.
    const addressLocks = KeyedMutex.makeUnsafe<SessionID>()

    // One live watcher per run keeps completion delivery exactly-once
    // (R2.4): a resume or extension attaches nothing when a watcher already
    // exists.
    const watchers = new Set<string>()

    const injectCompletion = Effect.fn("TaskEngine.injectCompletion")(function* (input: {
      ops: TaskPromptOps
      parentSession: SessionID
      variant: string | undefined
      runID: SessionID
      summary: string
      text: string
      state: "completed" | "error"
    }) {
      // The completion message is admitted as an ordinary parent prompt: the
      // parent session's own agent, or the default agent when the session has
      // none. The caller's agent must not leak into the parent admission.
      const currentParent = yield* sessions.get(input.parentSession)
      yield* input.ops
        .prompt({
          sessionID: input.parentSession,
          agent: currentParent.agent,
          variant: input.variant,
          parts: [
            {
              type: "text",
              synthetic: true,
              text: renderOutput({
                sessionID: input.runID,
                state: input.state,
                summary: input.summary,
                text: input.text,
              }),
            },
          ],
        })
        .pipe(
          // Swallowed on purpose (a failed completion delivery must not crash
          // the watcher), but the failure is diagnosable through the log.
          Effect.ignore({ log: "Error", message: "task completion admission failed" }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
    })

    const watch: Interface["watch"] = Effect.fn("TaskEngine.watch")(function* (input) {
      if (watchers.has(input.runID)) return
      watchers.add(input.runID)
      yield* background.wait({ id: input.runID }).pipe(
        // The settle-and-deliver section runs under the run's address lock:
        // a continuation's re-mark-and-start is mutually exclusive with it,
        // so the settle write cannot overwrite a re-marked running row, and
        // this watcher's registration is already gone (the teardown below
        // precedes the continuation's attach) when the continuation checks.
        Effect.flatMap((result) =>
          addressLocks.withLock(input.runID)(
            Effect.gen(function* () {
              const status = result.info?.status
              if (status !== "completed" && status !== "error" && status !== "cancelled") return
              // I4: the settle state is written before anything is delivered.
              yield* registry.settle({ id: input.runID, state: status })
              // R2.5: a cancelled run delivers no completion message — the
              // surface that cancelled it already knows.
              if (status === "cancelled") return
              yield* injectCompletion({
                ops: input.ops,
                parentSession: input.parentSession,
                variant: input.variant,
                runID: input.runID,
                summary: status === "completed" ? `Task completed: ${input.description}` : `Task failed: ${input.description}`,
                text: status === "completed" ? (result.info?.output ?? "") : (result.info?.error ?? ""),
                state: status,
              })
            }),
          ),
        ),
        Effect.ensuring(Effect.sync(() => watchers.delete(input.runID))),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    })

    const addressDecision = Effect.fn("TaskEngine.address")(function* (input: Parameters<Interface["address"]>[0]) {
      const childRun = () =>
        runChild({
          ops: input.ops,
          sessionID: input.runID,
          agentName: input.agentName,
          model: input.model,
          useAgentModel: input.useAgentModel,
          variant: input.variant,
          prompt: input.prompt,
        })

      const extended = yield* background.extend({ id: input.runID, run: childRun() })
      if (extended) {
        // The extended run keeps the original launch's completion contract:
        // this watcher owns its exactly-once delivery (R2.4).
        yield* watch(input)
        return "extended" as const
      }

      // R4.4: the row is re-marked running before the continuation prompt is
      // admitted; the admission happens inside the started job. The whole
      // decision runs under the run's lock, so a concurrent continue sees
      // this job as live and extends instead of racing the start.
      yield* registry.markRunning(input.runID)
      yield* background.start({
        id: input.runID,
        type: "task",
        title: input.description,
        metadata: input.metadata,
        run: childRun().pipe(Effect.onInterrupt(() => input.ops.cancel(input.runID))),
      })
      yield* watch(input)
      return "continued" as const
    })

    const address: Interface["address"] = (input) => addressLocks.withLock(input.runID)(addressDecision(input))

    return Service.of({ address, watch })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [BackgroundJob.node, Session.node, TaskRun.node],
})
