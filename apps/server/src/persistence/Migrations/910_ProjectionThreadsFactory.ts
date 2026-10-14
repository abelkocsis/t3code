import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The factory task state of a thread (input, phase, summary), as JSON. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "factory_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN factory_json TEXT
    `;
  }
});
