import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"

/**
 * The durable task-run registry row (specs/tool-task.md Task-run record,
 * R4.1). One row per subagent-run; `id` equals `child_session` because the
 * run identity of the spec is the child session id (R4.2). `state` is the
 * stored registry state, last write wins; a stored `running` row whose run
 * has no live job reads as `interrupted`, derived at read time and never
 * written (R4.11). `settled_at` is set only when the state leaves `running`.
 * The row is owned by its subagent session and removed with it through the
 * cascading foreign key (R4.8); the `parent_session` index backs the
 * session-scoped lists (I9).
 */
export const TaskRunTable = sqliteTable(
  "task_run",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    parent_session: text()
      .$type<SessionSchema.ID>()
      .notNull(),
    child_session: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    description: text().notNull(),
    state: text().$type<"running" | "completed" | "error" | "cancelled">().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    settled_at: integer(),
  },
  (table) => [index("task_run_parent_session_idx").on(table.parent_session)],
)
