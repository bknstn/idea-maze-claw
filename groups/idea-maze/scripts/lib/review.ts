import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";

import {
  artifactSourceRelativePath,
  queueGitHubArtifactExport,
  resolveArtifactPath,
  type GitHubExportState,
} from "./artifact-export.ts";
import { setOpportunityLifecycle } from "./opportunity-state.ts";
import { recordRunEvent } from "./run-events.ts";
import { recomputeAllOpportunityScores, updateTasteProfileFromDecision } from "./taste.ts";

const ARTIFACTS_REPO_URL = process.env.IDEA_MAZE_ARTIFACTS_REPO_URL?.trim() || null;
const ARTIFACTS_REPO_BRANCH = process.env.IDEA_MAZE_ARTIFACTS_REPO_BRANCH?.trim() || "main";

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

function renderSections(draft: ResearchDraft): string[] {
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

  const lines: string[] = [];
  for (const [title, body] of sections) {
    lines.push(`## ${title}`, "", body, "");
  }
  return lines;
}

export function renderMarkdown(
  draft: ResearchDraft,
  runId: number,
  createdAtUtc = new Date().toISOString(),
): string {
  const lines = [
    "---",
    `run_id: ${runId}`,
    `opportunity_slug: ${draft.opportunity_slug}`,
    `created_at_utc: ${createdAtUtc}`,
    `source_refs: [${draft.source_refs.join(", ")}]`,
    "---",
    "",
    ...renderSections(draft),
  ];

  return lines.join("\n").trim() + "\n";
}

export function artifactPath(slug: string, timestamp = new Date()): string {
  return resolveArtifactPath(artifactSourceRelativePath(slug, timestamp));
}

export function approveResearchRun(
  db: Database.Database,
  runId: number,
  notes: string | null = null,
): {
  githubExport: GitHubExportState;
  path: string;
  opportunityId: number;
  draft: ResearchDraft;
} {
  const run = getRun(db, runId);
  if (run.status !== "review_gate") {
    throw new Error(`Run #${runId} is not in review_gate (status: ${run.status}).`);
  }

  const draft = getDraft(run, runId);
  const opportunityId = Number(run.target_id);
  if (!db.prepare("SELECT 1 FROM opportunities WHERE id = ?").get(opportunityId)) {
    throw new Error(`Opportunity #${opportunityId} not found.`);
  }

  const approvedAt = new Date();
  const now = approvedAt.toISOString();
  const relativePath = artifactSourceRelativePath(draft.opportunity_slug, approvedAt);
  const path = resolveArtifactPath(relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderMarkdown(draft, runId, now), "utf-8");

  db.prepare(
    "INSERT INTO approvals (run_id, decision, notes, decided_at_utc) VALUES (?, 'approved', ?, ?)",
  ).run(runId, notes, now);
  const artifactInsert = db.prepare(
    "INSERT INTO artifacts (opportunity_id, run_id, path, version, approved_at_utc, created_at_utc) VALUES (?, ?, ?, 1, ?, ?)",
  ).run(opportunityId, runId, path, now, now);
  const artifactId = Number(artifactInsert.lastInsertRowid);
  const githubExport = queueGitHubArtifactExport(db, {
    artifactId,
    opportunityId,
    relativePath,
    repoBranch: ARTIFACTS_REPO_BRANCH,
    repoUrl: ARTIFACTS_REPO_URL,
    runId,
  });

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
      artifact_id: artifactId,
      artifact_path: path,
      artifact_relative_path: relativePath,
      github_export_repo_branch: ARTIFACTS_REPO_BRANCH,
      github_export_repo_url: ARTIFACTS_REPO_URL,
      github_export_status: githubExport.status,
      notes,
    },
    runId,
    stage: "review",
    status: "ok",
    summary: `Research run #${runId} approved.`,
  });

  return { githubExport, path, opportunityId, draft };
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
