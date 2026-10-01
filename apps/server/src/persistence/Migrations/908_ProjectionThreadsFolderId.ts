import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The sidebar folder a thread sits in; its name lives in server settings. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "folder_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN folder_id TEXT
    `;
  }
});
