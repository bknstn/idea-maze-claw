import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type Database from "better-sqlite3";

import { setOpportunityLifecycle } from "./opportunity-state.ts";
import { recordRunEvent } from "./run-events.ts";
import { recomputeAllOpportunityScores, updateTasteProfileFromDecision } from "./taste.ts";

const GROUP_DIR = process.env.WORKSPACE_GROUP ?? "/workspace/group";

export interface ResearchDraft {
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

function getRun(db: Database.Database, runId: number): any {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as any;
  if (!run) {
    throw new Error(`Run #${runId} not found.`);
  }
  return run;
}

function getDraft(run: any, runId: number): ResearchDraft {
  const meta = JSON.parse(run.metadata_json);
  const draft: ResearchDraft | undefined = meta.draft;
  if (!draft) {
    throw new Error(`Run #${runId} has no draft in metadata.`);
  }
  return draft;
}

export function renderMarkdown(draft: ResearchDraft, runId: number): string {
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

export function artifactPath(slug: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return resolve(GROUP_DIR, "data", "artifacts", String(y), m, d, `${slug}.md`);
}

export function approveResearchRun(
  db: Database.Database,
  runId: number,
  notes: string | null = null,
): { path: string; opportunityId: number; draft: ResearchDraft } {
  const run = getRun(db, runId);
  if (run.status !== "review_gate") {
    throw new Error(`Run #${runId} is not in review_gate (status: ${run.status}).`);
  }

  const draft = getDraft(run, runId);
  const opportunityId = Number(run.target_id);
  const opp = db.prepare("SELECT * FROM opportunities WHERE id = ?").get(opportunityId) as any;
  if (!opp) {
    throw new Error(`Opportunity #${opportunityId} not found.`);
  }

  const path = artifactPath(draft.opportunity_slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderMarkdown(draft, runId), "utf-8");

  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO approvals (run_id, decision, notes, decided_at_utc) VALUES (?, 'approved', ?, ?)",
  ).run(runId, notes, now);
  db.prepare(
    "INSERT INTO artifacts (opportunity_id, run_id, path, version, approved_at_utc, created_at_utc) VALUES (?, ?, ?, 1, ?, ?)",
  ).run(opportunityId, runId, path, now, now);
  db.prepare("UPDATE runs SET status = 'approved', completed_at_utc = ? WHERE id = ?").run(now, runId);
  db.prepare("UPDATE opportunities SET last_reviewed_at_utc = ? WHERE id = ?").run(now, opportunityId);
  setOpportunityLifecycle(db, opportunityId, "approved", {
    payload: {
      approval_notes: notes,
    },
    runId,
    summary: `Research run #${runId} approved.`,
  });
  updateTasteProfileFromDecision(db, {
    decision: "approved",
    opportunityId,
    runId,
  });
  recomputeAllOpportunityScores(db);
  recordRunEvent(db, {
    eventType: "review.approved",
    opportunityId,
    payload: {
      artifact_path: path,
      notes,
    },
    runId,
    stage: "review",
    status: "ok",
    summary: `Research run #${runId} approved.`,
  });

  return { path, opportunityId, draft };
}

export function rejectResearchRun(
  db: Database.Database,
  runId: number,
  notes: string | null = null,
): { opportunityId: number | null } {
  const run = getRun(db, runId);
  if (run.status !== "review_gate") {
    throw new Error(`Run #${runId} is not in review_gate (status: ${run.status}).`);
  }

  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO approvals (run_id, decision, notes, decided_at_utc) VALUES (?, 'rejected', ?, ?)",
  ).run(runId, notes, now);
  db.prepare("UPDATE runs SET status = 'rejected', completed_at_utc = ? WHERE id = ?").run(now, runId);

  const opportunityId = Number(run.target_id);
  if (Number.isFinite(opportunityId)) {
    db.prepare("UPDATE opportunities SET last_reviewed_at_utc = ? WHERE id = ?").run(now, opportunityId);
    setOpportunityLifecycle(db, opportunityId, "rejected", {
      payload: {
        rejection_notes: notes,
      },
      runId,
      summary: `Research run #${runId} rejected.`,
    });
    updateTasteProfileFromDecision(db, {
      decision: "rejected",
      opportunityId,
      runId,
    });
    recomputeAllOpportunityScores(db);
    recordRunEvent(db, {
      eventType: "review.rejected",
      opportunityId,
      payload: {
        notes,
      },
      runId,
      stage: "review",
      status: "ok",
      summary: `Research run #${runId} rejected.`,
    });
    return { opportunityId };
  }

  return { opportunityId: null };
}
