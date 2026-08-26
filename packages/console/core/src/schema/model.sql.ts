import { mysqlTable, varchar, text, uniqueIndex } from "drizzle-orm/mysql-core"
import { timestamps, workspaceColumns } from "../drizzle/types"
import { workspaceIndexes } from "./workspace.sql"

export const ModelTable = mysqlTable(
  "model",
  {
    ...workspaceColumns,
    ...timestamps,
    model: varchar("model", { length: 64 }).notNull(),
    primeTimeStart: text("prime_time_start"),
    primeTimeEnd: text("prime_time_end"),
    primeTimeDay: text("prime_time_day"),
  },
  (table) => [...workspaceIndexes(table), uniqueIndex("model_workspace_model").on(table.workspaceID, table.model)],
)
