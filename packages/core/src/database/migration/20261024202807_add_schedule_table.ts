import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261024202807_add_schedule_table",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`schedule\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`cron\` text,
          \`at\` integer,
          \`message\` text NOT NULL,
          \`next_fire_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_schedule_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`schedule_next_fire_at_idx\` ON \`schedule\` (\`next_fire_at\`);`)
      yield* tx.run(`CREATE INDEX \`schedule_session_idx\` ON \`schedule\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
