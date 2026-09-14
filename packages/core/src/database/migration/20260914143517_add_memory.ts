import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260914143517_add_memory",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`scope_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`title\` text NOT NULL,
          \`content\` text NOT NULL,
          \`tags\` text NOT NULL,
          \`source\` text NOT NULL,
          \`source_ref\` text,
          \`status\` text NOT NULL,
          \`confidence\` real NOT NULL,
          \`importance\` integer NOT NULL,
          \`created_by\` text NOT NULL,
          \`directory\` text,
          \`fingerprint\` text NOT NULL,
          \`validated_at\` integer,
          \`validation\` text,
          \`superseded_by\` text,
          \`time_last_used\` integer,
          \`use_count\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_use\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`session_id\` text NOT NULL,
          \`memory_id\` text NOT NULL,
          \`agent\` text,
          \`message_id\` text,
          \`score\` real NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_memory_use_memory_id_memory_id_fk\` FOREIGN KEY (\`memory_id\`) REFERENCES \`memory\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`memory_scope_status_idx\` ON \`memory\` (\`scope\`,\`scope_id\`,\`status\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`memory_scope_fingerprint_idx\` ON \`memory\` (\`scope\`,\`scope_id\`,\`fingerprint\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_status_updated_idx\` ON \`memory\` (\`status\`,\`time_updated\`);`)
      yield* tx.run(`CREATE INDEX \`memory_superseded_by_idx\` ON \`memory\` (\`superseded_by\`);`)
      yield* tx.run(`CREATE INDEX \`memory_use_session_time_idx\` ON \`memory_use\` (\`session_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`memory_use_memory_idx\` ON \`memory_use\` (\`memory_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
