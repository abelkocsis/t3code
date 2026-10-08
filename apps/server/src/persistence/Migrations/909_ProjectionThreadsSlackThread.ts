import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The Slack thread a thread's review requests are posted in, as JSON. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "slack_thread_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN slack_thread_json TEXT
    `;
  }
});
