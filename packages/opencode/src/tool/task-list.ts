import * as Tool from "./tool"
import DESCRIPTION from "./task-list.txt"
import { Effect, Schema } from "effect"
import { renderSnapshot } from "@/task/engine"
import { TaskRun } from "@opencode-ai/core/task-run/task-run"

const id = "task_list"

export const Parameters = Schema.Struct({})

/**
 * The read-only list surface of the durable task-run registry
 * (specs/tool-task.md task_list tool, R6.1-R6.2): a V1 built-in that takes no
 * arguments, asks no permission, and mutates no registry row. The result
 * lists every subagent-run of the calling session — one status snapshot
 * block per run, newest launch first, ties ordered by run id ascending.
 */
export const TaskListTool = Tool.define(
  id,
  Effect.gen(function* () {
    const registry = yield* TaskRun.Service

    const run = Effect.fn("TaskListTool.execute")(function* (
      _params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
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
