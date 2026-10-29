import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { TaskEngine, renderOutput, renderSnapshot, runChild } from "@/task/engine"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Effect, Schema, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { TaskRun } from "@opencode-ai/core/task-run/task-run"

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
const CONTINUED_TEXT = [
  "The prompt was delivered to the task's session; the task is working in the background with the earlier conversation in context.",
  "Its result will arrive as a separate session message when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

export const Parameters = Schema.Struct({
  description: Schema.optional(Schema.String).annotate({
    description: "A short (3-5 words) description of the task. Required for a new task; omit it when addressing an existing task_id.",
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description:
      "The task for the agent to perform. Required for a new task; with task_id it is the message delivered to that task (an extension while it runs, a continuation of its session otherwise). Omit task_id and prompt entirely to read a task's status.",
  }),
  subagent_type: Schema.optional(Schema.String).annotate({
    description: "The type of specialized agent to use for this task. Required for a new task; omit it when addressing an existing task_id.",
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "The id of a previously launched task. Without a prompt the call reads the task's status; with a prompt it extends the running task or continues its session. A fresh launch passes no task_id.",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
})

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const engine = yield* TaskEngine.Service
    const registry = yield* TaskRun.Service
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
          patterns: [params.subagent_type!],
          always: ["*"],
          metadata: {
            description: params.description!,
            subagent_type: params.subagent_type!,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type!)
      if (!next) {
        return yield* Effect.fail(
          new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`),
        )
      }

      const session = yield* sessions.create({
        parentID: ctx.sessionID,
        title: params.description! + ` (@${next.name} subagent)`,
        agent: next.name,
        permission: childPermissionRules(parent, next, cfg),
      })
      return { next, session }
    })

    /** R1.5: the status-only call — no launch, no write, no permission ask. */
    const resolveStatus = Effect.fn("TaskTool.resolveStatus")(function* (input: {
      ctx: Tool.Context
      taskID: string
    }) {
      const row = yield* registry.get(input.ctx.sessionID, input.taskID)
      if (!row) {
        return yield* Effect.fail(new Error(`task-not-found: no task ${input.taskID} was launched by this session`))
      }
      return {
        title: row.description,
        metadata: { parentSessionId: input.ctx.sessionID, sessionId: row.id, background: true },
        output: renderSnapshot(row),
      }
    })

    /**
     * R1.6, R1.7: a task_id call carrying a prompt — a live job receives the
     * prompt as additional input; a run with no live job continues its
     * durable session. R1.8: an unresolvable task_id fails with
     * `task-not-found` and performs nothing.
     */
    const resolveAddressed = Effect.fn("TaskTool.resolveAddressed")(function* (input: {
      params: Schema.Schema.Type<typeof Parameters>
      ctx: Tool.Context
      taskID: string
    }) {
      const row = yield* registry.get(input.ctx.sessionID, input.taskID)
      if (!row) {
        return yield* Effect.fail(new Error(`task-not-found: no task ${input.taskID} was launched by this session`))
      }

      const msg = yield* MessageV2.get({ sessionID: input.ctx.sessionID, messageID: input.ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const child = yield* sessions.get(row.childSession)
      const next = yield* agent.get(child.agent ?? "")
      if (!next) {
        return yield* Effect.fail(
          new Error(`Unknown agent type: ${child.agent} is not a valid agent type for task ${row.id}`),
        )
      }
      const model = next.model ?? { modelID: msg.info.modelID, providerID: msg.info.providerID }
      const ops = input.ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const branch = yield* engine.address({
        ops,
        parentSession: input.ctx.sessionID,
        variant,
        runID: row.id,
        description: row.description,
        agentName: next.name,
        model,
        useAgentModel: next.model !== undefined,
        metadata: {
          parentSessionId: input.ctx.sessionID,
          sessionId: row.id,
          model,
          background: true,
          jobId: row.id,
        },
        prompt: input.params.prompt!,
      })

      const running = (summary: string, text: string) => ({
        title: row.description,
        metadata: { parentSessionId: input.ctx.sessionID, sessionId: row.id, model, background: true, jobId: row.id },
        output: renderOutput({ sessionID: row.id, state: "running", summary, text }),
      })
      return branch === "extended"
        ? running("Task updated", RUNNING_UPDATED_TEXT)
        : running("Task continued", CONTINUED_TEXT)
    })

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      // Addressed calls resolve against the durable task-run registry before
      // anything else runs: a task_id that resolves to no run of the calling
      // session fails with task-not-found and performs nothing (R1.8).
      if (params.task_id !== undefined) {
        if (params.prompt === undefined) return yield* resolveStatus({ ctx, taskID: params.task_id })
        return yield* resolveAddressed({ params, ctx, taskID: params.task_id })
      }

      if (!params.prompt || !params.description || !params.subagent_type) {
        return yield* Effect.fail(
          new Error("Task requires prompt, description, and subagent_type when task_id is not set"),
        )
      }

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

      // R4.3: the launch inserts the run row with the stored running state at
      // launch time; id equals the child session id (R4.2).
      yield* registry.launch({
        id: nextSession.id,
        parentSession: ctx.sessionID,
        childSession: nextSession.id,
        description: params.description,
      })

      yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata: { ...metadata, jobId: nextSession.id },
        run: runChild({
          ops,
          sessionID: nextSession.id,
          agentName: launch.next.name,
          model,
          useAgentModel: launch.next.model !== undefined,
          variant,
          prompt: params.prompt,
        }).pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      // R1.1: every launch is asynchronous — the watcher is attached and the
      // running result returns before the run settles (T1.1); the settled
      // outcome reaches the parent session only through the completion
      // message (R1.9).
      yield* engine.watch({
        ops,
        parentSession: ctx.sessionID,
        variant,
        runID: nextSession.id,
        description: params.description,
      })
      return {
        title: params.description,
        metadata: { ...metadata, jobId: nextSession.id },
        output: renderOutput({ sessionID: nextSession.id, state: "running", summary: "Task started", text: RUNNING_TEXT }),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
