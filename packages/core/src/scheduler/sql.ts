import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { SessionTable } from "../session/sql"
import { SessionSchema } from "../session/schema"
import { ScheduleID } from "./schema"

/**
 * The schedule table (specs/scheduler.md Schedule record, R4.1, I3). Rows are
 * owned by their session and removed with it through the cascading foreign
 * key (R4.2). Exactly one of `cron` and `at` is non-null per row: the stored
 * cron-spec of a recurring schedule, or the due time of a one-shot — the
 * invariant is enforced by the write paths of the scheduler service, not by a
 * database constraint. `command` carries the stored scheduler/gate-command
 * text; it is nullable with no default, and a null stores no gate so
 * existing rows decode with no gate (R6.11). `next_fire_at` carries the
 * stored next-due-time; its index backs the delivery loop's due-time scan,
 * the `session_id` index backs list and cascade (I3).
 */
export const ScheduleTable = sqliteTable(
  "schedule",
  {
    id: text().$type<ScheduleID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    cron: text(),
    at: integer(),
    message: text().notNull(),
    command: text(),
    next_fire_at: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("schedule_next_fire_at_idx").on(table.next_fire_at),
    index("schedule_session_idx").on(table.session_id),
  ],
)
