import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261030112742_add_schedule_name",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`schedule\` ADD \`name\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
