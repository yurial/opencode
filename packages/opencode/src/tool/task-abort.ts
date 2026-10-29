import * as Tool from "./tool"
import DESCRIPTION from "./task-abort.txt"
import { Effect, Schema } from "effect"
import { BackgroundJob } from "@/background/job"
import { renderSnapshot } from "@/task/engine"
import type { TaskPromptOps } from "./task"
import { TaskRun } from "@opencode-ai/core/task-run/task-run"

const id = "task_abort"

export const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({
    description: "The id of the task to stop — a task launched by this session with the task tool.",
  }),
})

/**
 * The stop surface of the durable task-run registry (specs/tool-task.md
 * task_abort tool, R7.1-R7.6): a V1 built-in that asks no permission — a stop
 * ends work whose launch already passed its ask. The liveness decision tree:
 * a run with a live job has the job cancelled together with the child
 * session's in-flight work and the row records the cancel with its settle
 * time (R7.2, R4.6); a stored `running` row without a live job is re-marked
 * `cancelled` (R7.3); a settled run is an idempotent no-op (R7.4). No
 * completion message is delivered (R2.5) — the cancelled branch of the
 * completion watcher delivers nothing. Every success result is the status
 * snapshot of the addressed run, read after the operation applies (R7.6).
 */
export const TaskAbortTool = Tool.define(
  id,
  Effect.gen(function* () {
    const registry = yield* TaskRun.Service
    const background = yield* BackgroundJob.Service

    const run = Effect.fn("TaskAbortTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const row = yield* registry.get(ctx.sessionID, params.task_id)
      if (!row) {
        return yield* Effect.fail(
          new Error(`task-not-found: no task ${params.task_id} was launched by this session`),
        )
      }

      // R7.2: a live job — record the cancel write, cancel the job, and abort
      // the child session's in-flight work through the same prompt cancel the
      // session abort uses (the run's interruption hook also cancels it).
      if (row.state === "running") {
        const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
        if (!ops) return yield* Effect.fail(new Error("TaskAbortTool requires promptOps in ctx.extra"))
        yield* registry.settle({ id: row.id, state: "cancelled" })
        yield* background.cancel(row.id)
        yield* ops.cancel(row.childSession)
      }

      // R7.3: the interrupted reading — an explicit stop re-marks the row
      // `cancelled` with the settle time and resumes no execution.
      if (row.state === "interrupted") {
        yield* registry.settle({ id: row.id, state: "cancelled" })
      }

      // R7.4: a settled row — stored completed, error, or cancelled — is left
      // untouched. R7.6: the result snapshot is read after the operation
      // applies; a row deleted mid-call cascades away, and the pre-read row is
      // the best available description then.
      const after = (yield* registry.get(ctx.sessionID, params.task_id)) ?? row
      return {
        title: after.description,
        metadata: { parentSessionId: ctx.sessionID, sessionId: after.id },
        output: renderSnapshot(after),
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
