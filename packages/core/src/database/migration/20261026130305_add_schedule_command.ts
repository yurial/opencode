import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261026130305_add_schedule_command",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`schedule\` ADD \`command\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
