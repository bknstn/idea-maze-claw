/**
 * Reject a research run — records the decision without writing an artifact.
 *
 * Usage: tsx reject-run.ts <run_id> [notes]
 */

import { getDb, closeDb } from "./lib/db.ts";
import { rejectResearchRun } from "./lib/review.ts";
import { initSchema } from "./lib/schema.ts";

function main() {
  const runIdStr = process.argv[2];
  if (!runIdStr) {
    console.error("Usage: tsx reject-run.ts <run_id> [notes]");
    process.exit(1);
  }

  const runId = Number(runIdStr);
  const notes = process.argv.slice(3).join(" ") || null;

  const db = getDb();
  initSchema(db);
  try {
    rejectResearchRun(db, runId, notes);
    console.log(`Run #${runId} rejected.`);
    if (notes) console.log(`Notes: ${notes}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

main();
