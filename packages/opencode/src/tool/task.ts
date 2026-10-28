import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Database } from "@opencode-ai/core/database/database"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
const RUNNING_TEXT = [
  "The task is running in the background. Its result will arrive as a separate session message when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const RUNNING_UPDATED_TEXT = [
  "Additional context sent to the running task.",
  "The task is still working in the background. Its result will arrive as a separate session message when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  wait: Schema.optional(Schema.Boolean).annotate({
    description:
      "Wait for the task to finish and return its result in this tool call. Tasks run in the background by default and return immediately; the result arrives later as a separate session message.",
  }),
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const database = yield* Database.Service

    const checkDepth = Effect.fn("TaskTool.checkDepth")(function* (parent: Session.Info, cfg: ConfigV1.Info) {
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }
    })

    const childPermissionRules = (parent: Session.Info, next: Agent.Info, cfg: ConfigV1.Info) => {
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      return [
        ...childPermission,
        ...childToolDenies.filter(
          (deny) =>
            !childPermission.some(
              (rule) =>
                rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
            ),
        ),
      ]
    }

    const resolveLaunch = Effect.fn("TaskTool.resolveLaunch")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
      cfg: ConfigV1.Info,
    ) {
      const parent = yield* sessions.get(ctx.sessionID)
      yield* checkDepth(parent, cfg)

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const existing = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const session =
        existing ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: childPermissionRules(parent, next, cfg),
        }))
      return { next, session }
    })

    const runSubagent = Effect.fn("TaskTool.runSubagent")(function* (input: {
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

    const injectCompletion = Effect.fn("TaskTool.injectCompletion")(function* (input: {
      ops: TaskPromptOps
      ctx: Tool.Context
      variant: string | undefined
      runID: SessionID
      summary: string
      text: string
      state: "completed" | "error"
    }) {
      const currentParent = yield* sessions.get(input.ctx.sessionID)
      // The completion message is admitted as an ordinary parent prompt: the
      // parent session's own agent, or the default agent when the session has
      // none. ctx.agent is the caller's agent and may name the subagent (the
      // subtask path), so it must not leak into the parent admission.
      yield* input.ops
        .prompt({
          sessionID: input.ctx.sessionID,
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
        .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
    })

    const notifyCompletion = Effect.fn("TaskTool.notifyCompletion")(function* (input: {
      ops: TaskPromptOps
      ctx: Tool.Context
      variant: string | undefined
      runID: SessionID
      description: string
    }) {
      yield* background
        .wait({ id: input.runID })
        .pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed")
              return injectCompletion({
                ops: input.ops,
                ctx: input.ctx,
                variant: input.variant,
                runID: input.runID,
                summary: `Task completed: ${input.description}`,
                text: result.info.output ?? "",
                state: "completed",
              })
            if (result.info?.status === "error")
              return injectCompletion({
                ops: input.ops,
                ctx: input.ctx,
                variant: input.variant,
                runID: input.runID,
                summary: `Task failed: ${input.description}`,
                text: result.info.error ?? "",
                state: "error",
              })
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
    })

    const waitForSettlement = Effect.fn("TaskTool.waitForSettlement")(function* (input: {
      ctx: Tool.Context
      runID: SessionID
      cancel: Effect.Effect<void>
      title: string
      metadata: Record<string, any>
    }) {
      const runCancel = yield* EffectBridge.make()

      function onAbort() {
        runCancel.fork(input.cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          input.ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* background.wait({ id: input.runID })
            if (result.info?.status === "error") return yield* Effect.fail(new Error(result.info.error ?? "Task failed"))
            if (result.info?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: input.title,
              metadata: input.metadata,
              output: renderOutput({ sessionID: input.runID, state: "completed", text: result.info?.output ?? "" }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([input.cancel, background.cancel(input.runID)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                input.ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const launch = yield* resolveLaunch(params, ctx, cfg)
      const nextSession = launch.session

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const model = launch.next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        background: true,
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const subagentRun = () =>
        runSubagent({
          ops,
          sessionID: nextSession.id,
          agentName: launch.next.name,
          model,
          useAgentModel: launch.next.model !== undefined,
          variant,
          prompt: params.prompt,
        })

      const runningResult = (summary: string, text: string) => ({
        title: params.description,
        metadata: { ...metadata, jobId: nextSession.id },
        output: renderOutput({ sessionID: nextSession.id, state: "running", summary, text }),
      })

      // A resumed launch against a still-running task queues its prompt onto
      // the live job; the job's single completion watcher keeps delivery
      // exactly-once per settled run.
      if (yield* background.extend({ id: nextSession.id, run: subagentRun() })) {
        return runningResult("Task updated", RUNNING_UPDATED_TEXT)
      }

      yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata: { ...metadata, jobId: nextSession.id },
        run: subagentRun().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      if (params.wait === true) {
        return yield* waitForSettlement({
          ctx,
          runID: nextSession.id,
          cancel: ops.cancel(nextSession.id),
          title: params.description,
          metadata,
        })
      }

      yield* notifyCompletion({
        ops,
        ctx,
        variant,
        runID: nextSession.id,
        description: params.description,
      })
      return runningResult("Task started", RUNNING_TEXT)
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
