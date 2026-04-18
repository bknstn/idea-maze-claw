/**
 * Approve a research run — writes a Markdown artifact and records the decision.
 *
 * Usage: tsx approve-run.ts <run_id> [notes]
 */

import { getDb, closeDb } from "./lib/db.ts";
import { approveResearchRun } from "./lib/review.ts";
import { initSchema } from "./lib/schema.ts";

function main() {
  const runIdStr = process.argv[2];
  if (!runIdStr) {
    console.error("Usage: tsx approve-run.ts <run_id> [notes]");
    process.exit(1);
  }

  const runId = Number(runIdStr);
  const notes = process.argv.slice(3).join(" ") || null;

  const db = getDb();
  initSchema(db);
  try {
    const { obsidianPath, path, repoMirror } = approveResearchRun(db, runId, notes);
    console.log(`Run #${runId} approved.`);
    console.log(`Artifact written: ${path}`);
    if (repoMirror?.pushed) {
      console.log(
        `GitHub mirror pushed: ${repoMirror.repoUrl} (${repoMirror.relativePath} @ ${repoMirror.commitSha?.slice(0, 7)})`,
      );
    } else if (repoMirror) {
      console.log(`GitHub mirror unchanged: ${repoMirror.repoUrl} (${repoMirror.relativePath})`);
    }
    if (obsidianPath) console.log(`Obsidian export written: ${obsidianPath}`);
    if (notes) console.log(`Notes: ${notes}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

main();
