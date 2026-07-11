import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260712000000_add_session_automode",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD COLUMN \`automode\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
