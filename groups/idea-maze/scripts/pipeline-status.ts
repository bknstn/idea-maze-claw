import { closeDb, getDb } from "./lib/db.ts";
import { buildPipelineStatusReport } from "./lib/observability.ts";
import { initSchema } from "./lib/schema.ts";

function main() {
  const db = getDb();
  initSchema(db);
  try {
    process.stdout.write(buildPipelineStatusReport(db));
  } finally {
    closeDb();
  }
}

main();
