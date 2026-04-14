/**
 * Research drafting — creates a research run for an opportunity.
 *
 * Loads the opportunity and linked source items, optionally enriches
 * with Tavily web search, builds a draft, and moves the run to review_gate.
 *
 * Usage: tsx research-opportunity.ts <slug-or-topic>
 */

import { researchOpportunity } from "./lib/research.ts";

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: tsx research-opportunity.ts <slug-or-topic>");
    process.exit(1);
  }
  await researchOpportunity(target, {
    approvalMode: "review_gate",
    requestedBy: "user",
  });
}

main().catch((err) => {
  console.error("Research failed:", err);
  process.exit(1);
});
