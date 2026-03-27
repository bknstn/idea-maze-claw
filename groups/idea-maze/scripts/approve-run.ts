/**
 * Approve a research run — writes a Markdown artifact and records the decision.
 *
 * Usage: tsx approve-run.ts <run_id> [notes]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { getDb, closeDb } from "./lib/db.ts";
import { initSchema } from "./lib/schema.ts";

const GROUP_DIR = process.env.WORKSPACE_GROUP ?? "/workspace/group";

interface ResearchDraft {
  opportunity_slug: string;
  thesis: string;
  evidence_from_inbox: string[];
  evidence_from_telegram: string[];
  evidence_from_reddit: string[];
  external_market_check: string[];
  product_concept: string;
  mvp_scope: string[];
  implementation_plan: string[];
  distribution_plan: string[];
  risks: string[];
  decision_for_human_review: string;
  source_refs: number[];
}

function renderMarkdown(draft: ResearchDraft, runId: number): string {
  const now = new Date().toISOString();
  const fmtList = (items: string[]) =>
    items.length ? items.map((s) => `- ${s}`).join("\n") : "- None";

  const sections: [string, string][] = [
    ["Thesis", draft.thesis],
    ["Evidence from Inbox", fmtList(draft.evidence_from_inbox)],
    ["Evidence from Telegram", fmtList(draft.evidence_from_telegram)],
    ["Evidence from Reddit", fmtList(draft.evidence_from_reddit)],
    ["External Market Check", fmtList(draft.external_market_check)],
    ["Product Concept", draft.product_concept],
    ["MVP Scope", fmtList(draft.mvp_scope)],
    ["Implementation Plan", fmtList(draft.implementation_plan)],
    ["Distribution Plan", fmtList(draft.distribution_plan)],
    ["Risks / Unknowns", fmtList(draft.risks)],
    ["Decision for Human Review", draft.decision_for_human_review],
  ];

  const lines = [
    "---",
    `run_id: ${runId}`,
    `opportunity_slug: ${draft.opportunity_slug}`,
    `created_at_utc: ${now}`,
    `source_refs: [${draft.source_refs.join(", ")}]`,
    "---",
    "",
  ];

  for (const [title, body] of sections) {
    lines.push(`## ${title}`, "", body, "");
  }

  return lines.join("\n").trim() + "\n";
}

function artifactPath(slug: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return resolve(GROUP_DIR, "data", "artifacts", String(y), m, d, `${slug}.md`);
}

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

  // Load run
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as any;
  if (!run) {
    console.error(`Run #${runId} not found.`);
    process.exit(1);
  }
  if (run.status !== "review_gate") {
    console.error(`Run #${runId} is not in review_gate (status: ${run.status}).`);
    process.exit(1);
  }

  const meta = JSON.parse(run.metadata_json);
  const draft: ResearchDraft = meta.draft;
  if (!draft) {
    console.error(`Run #${runId} has no draft in metadata.`);
    process.exit(1);
  }

  // Find opportunity
  const opportunityId = Number(run.target_id);
  const opp = db.prepare("SELECT * FROM opportunities WHERE id = ?").get(opportunityId) as any;
  if (!opp) {
    console.error(`Opportunity #${opportunityId} not found.`);
    process.exit(1);
  }

  // Render and write artifact
  const path = artifactPath(draft.opportunity_slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderMarkdown(draft, runId), "utf-8");

  const now = new Date().toISOString();

  // Create approval record
  db.prepare(
    "INSERT INTO approvals (run_id, decision, notes, decided_at_utc) VALUES (?, 'approved', ?, ?)",
  ).run(runId, notes, now);

  // Create artifact record
  db.prepare(
    "INSERT INTO artifacts (opportunity_id, run_id, path, version, approved_at_utc, created_at_utc) VALUES (?, ?, ?, 1, ?, ?)",
  ).run(opportunityId, runId, path, now, now);

  // Update run status
  db.prepare("UPDATE runs SET status = 'approved', completed_at_utc = ? WHERE id = ?").run(now, runId);

  console.log(`Run #${runId} approved.`);
  console.log(`Artifact written: ${path}`);
  if (notes) console.log(`Notes: ${notes}`);

  closeDb();
}

main();
