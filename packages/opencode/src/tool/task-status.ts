import * as Tool from "./tool"
import DESCRIPTION from "./task-status.txt"
import { Effect, Schema } from "effect"
import { renderSnapshot } from "@/task/engine"
import { TaskRun } from "@opencode-ai/core/task-run/task-run"

const id = "task_status"

export const Parameters = Schema.Struct({
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "The id of one task launched by this session. Omit it to list every task of the session, newest launch first.",
  }),
})

/**
 * The read-only status surface of the durable task-run registry
 * (specs/tool-task.md task_status tool, R5.1-R5.3): a V1 built-in that asks
 * no permission and mutates no registry row. Without `task_id` it lists the
 * subagent-runs of the calling session, newest launch first; with `task_id`
 * it returns the status snapshot of one addressed run, failing with
 * `task-not-found` when the id resolves to no run of the calling session.
 */
export const TaskStatusTool = Tool.define(
  id,
  Effect.gen(function* () {
    const registry = yield* TaskRun.Service

    const run = Effect.fn("TaskStatusTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (params.task_id !== undefined) {
        const row = yield* registry.get(ctx.sessionID, params.task_id)
        if (!row) {
          return yield* Effect.fail(
            new Error(`task-not-found: no task ${params.task_id} was launched by this session`),
          )
        }
        return {
          title: row.description,
          metadata: { parentSessionId: ctx.sessionID, sessionId: row.id },
          output: renderSnapshot(row),
        }
      }

      const rows = yield* registry.list(ctx.sessionID)
      const output =
        rows.length === 0
          ? "No tasks have been launched by this session."
          : rows.map(renderSnapshot).join("\n")
      return {
        title: `${rows.length} task${rows.length === 1 ? "" : "s"}`,
        metadata: { parentSessionId: ctx.sessionID, sessionId: ctx.sessionID },
        output,
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
