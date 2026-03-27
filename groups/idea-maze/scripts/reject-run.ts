/**
 * Reject a research run — records the decision without writing an artifact.
 *
 * Usage: tsx reject-run.ts <run_id> [notes]
 */

import { getDb, closeDb } from "./lib/db.ts";
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

  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as any;
  if (!run) {
    console.error(`Run #${runId} not found.`);
    process.exit(1);
  }
  if (run.status !== "review_gate") {
    console.error(`Run #${runId} is not in review_gate (status: ${run.status}).`);
    process.exit(1);
  }

  const now = new Date().toISOString();

  // Create rejection record
  db.prepare(
    "INSERT INTO approvals (run_id, decision, notes, decided_at_utc) VALUES (?, 'rejected', ?, ?)",
  ).run(runId, notes, now);

  // Update run status
  db.prepare("UPDATE runs SET status = 'rejected', completed_at_utc = ? WHERE id = ?").run(now, runId);

  console.log(`Run #${runId} rejected.`);
  if (notes) console.log(`Notes: ${notes}`);

  closeDb();
}

main();
