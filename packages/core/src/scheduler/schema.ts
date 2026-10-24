export * as SchedulerSchema from "./schema"

import { Schema } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import { statics } from "../schema"

/**
 * Identifier of a scheduler/schedule (specs/scheduler.md Definitions).
 *
 * Domain: a string with the `sch_` prefix followed by an ascending identifier.
 * `create()` mints a fresh, lexicographically sortable id; the prefix is part
 * of the validated shape, so a decoded `ScheduleID` always starts with `sch_`.
 * The id is unique across the schedule table (primary key); passing an unknown
 * id to remove resolves to "not found" rather than an error of its own.
 */
export const ScheduleID = Schema.String.check(Schema.isStartsWith("sch_")).pipe(
  Schema.brand("ScheduleID"),
  statics((schema) => ({
    create: () => schema.make("sch_" + ascending()),
  })),
)

export type ScheduleID = Schema.Schema.Type<typeof ScheduleID>
