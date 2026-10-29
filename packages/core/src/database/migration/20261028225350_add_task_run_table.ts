import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028225350_add_task_run_table",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`task_run\` (
          \`id\` text PRIMARY KEY,
          \`parent_session\` text NOT NULL,
          \`child_session\` text NOT NULL,
          \`description\` text NOT NULL,
          \`state\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          \`settled_at\` integer,
          CONSTRAINT \`fk_task_run_child_session_session_id_fk\` FOREIGN KEY (\`child_session\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`task_run_parent_session_idx\` ON \`task_run\` (\`parent_session\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
