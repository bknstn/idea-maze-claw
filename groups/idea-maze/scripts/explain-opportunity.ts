import { closeDb, getDb } from "./lib/db.ts";
import { buildOpportunityExplanation } from "./lib/observability.ts";
import { initSchema } from "./lib/schema.ts";

function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: tsx explain-opportunity.ts <slug>");
    process.exit(1);
  }

  const db = getDb();
  initSchema(db);
  try {
    process.stdout.write(buildOpportunityExplanation(db, slug));
  } finally {
    closeDb();
  }
}

main();
