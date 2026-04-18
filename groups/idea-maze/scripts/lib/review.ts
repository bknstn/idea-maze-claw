import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";

import { readEnvFile } from "../../../../src/env.ts";
import { setOpportunityLifecycle } from "./opportunity-state.ts";
import { recordRunEvent } from "./run-events.ts";
import { recomputeAllOpportunityScores, updateTasteProfileFromDecision } from "./taste.ts";

const GROUP_DIR = process.env.WORKSPACE_GROUP ?? "/workspace/group";
const envConfig = readEnvFile([
  "IDEA_MAZE_ARTIFACTS_REPO_BRANCH",
  "IDEA_MAZE_ARTIFACTS_REPO_DIR",
  "IDEA_MAZE_ARTIFACTS_REPO_URL",
  "IDEA_MAZE_OBSIDIAN_EXPORT_DIR",
]);

function readConfigValue(key: keyof typeof envConfig | string): string | null {
  const runtimeValue = process.env[key]?.trim();
  if (runtimeValue) return runtimeValue;
  const envFileValue = envConfig[key]?.trim();
  return envFileValue ? envFileValue : null;
}

function resolveConfiguredPath(value: string | null): string | null {
  return value ? resolve(value) : null;
}

const OBSIDIAN_EXPORT_DIR = resolveConfiguredPath(readConfigValue("IDEA_MAZE_OBSIDIAN_EXPORT_DIR"));
const ARTIFACTS_REPO_URL = readConfigValue("IDEA_MAZE_ARTIFACTS_REPO_URL");
const ARTIFACTS_REPO_DIR = ARTIFACTS_REPO_URL
  ? resolveConfiguredPath(readConfigValue("IDEA_MAZE_ARTIFACTS_REPO_DIR")) ?? resolve(GROUP_DIR, "data", "artifacts-repo")
  : null;
const ARTIFACTS_REPO_BRANCH = readConfigValue("IDEA_MAZE_ARTIFACTS_REPO_BRANCH") ?? "main";

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

export interface ArtifactRepoMirrorResult {
  branch: string;
  checkoutDir: string;
  commitSha: string | null;
  localPath: string;
  pushed: boolean;
  relativePath: string;
  repoUrl: string;
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

export function renderMarkdown(draft: ResearchDraft, runId: number, createdAtUtc = new Date().toISOString()): string {
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

export function renderObsidianMarkdown(
  draft: ResearchDraft,
  runId: number,
  opportunityTitle: string,
  artifactPath: string,
  createdAtUtc = new Date().toISOString(),
): string {
  const lines = [
    "---",
    `title: ${JSON.stringify(opportunityTitle)}`,
    `opportunity_slug: ${JSON.stringify(draft.opportunity_slug)}`,
    `run_id: ${runId}`,
    `created_at_utc: ${JSON.stringify(createdAtUtc)}`,
    `canonical_artifact_path: ${JSON.stringify(artifactPath)}`,
    `source_refs: [${draft.source_refs.join(", ")}]`,
    "tags:",
    "  - idea-maze",
    "  - research-opportunity",
    "---",
    "",
    `# ${opportunityTitle}`,
    "",
    "_Mirrored from the approved NanoClaw artifact._",
    "",
    ...renderSections(draft),
  ];

  return lines.join("\n").trim() + "\n";
}

export function artifactPath(slug: string, timestamp = new Date()): string {
  const y = timestamp.getUTCFullYear();
  const m = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  const d = String(timestamp.getUTCDate()).padStart(2, "0");
  return resolve(GROUP_DIR, "data", "artifacts", String(y), m, d, `${slug}.md`);
}

export function artifactRepoRelativePath(slug: string, timestamp = new Date()): string {
  const y = timestamp.getUTCFullYear();
  const m = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  const d = String(timestamp.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${d}/${slug}.md`;
}

export function obsidianArtifactPath(slug: string, timestamp = new Date()): string | null {
  if (!OBSIDIAN_EXPORT_DIR) {
    return null;
  }

  const y = timestamp.getUTCFullYear();
  const m = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  const d = String(timestamp.getUTCDate()).padStart(2, "0");
  return resolve(OBSIDIAN_EXPORT_DIR, String(y), m, d, `${slug}.md`);
}

function summarizeExecError(err: unknown): string {
  if (err instanceof Error) {
    const stdout = typeof (err as any).stdout === "string" ? (err as any).stdout.trim() : "";
    const stderr = typeof (err as any).stderr === "string" ? (err as any).stderr.trim() : "";
    return stderr || stdout || err.message;
  }
  return String(err);
}

function runGitCommand(args: string[], cwd?: string): string {
  const gitArgs = cwd ? ["-C", cwd, ...args] : args;
  return execFileSync("git", gitArgs, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function ensureArtifactsRepoCheckout(): { checkoutDir: string; repoUrl: string; branch: string } | null {
  if (!ARTIFACTS_REPO_URL || !ARTIFACTS_REPO_DIR) {
    return null;
  }

  if (!existsSync(join(ARTIFACTS_REPO_DIR, ".git"))) {
    mkdirSync(dirname(ARTIFACTS_REPO_DIR), { recursive: true });
    runGitCommand([
      "clone",
      "--branch",
      ARTIFACTS_REPO_BRANCH,
      "--single-branch",
      ARTIFACTS_REPO_URL,
      ARTIFACTS_REPO_DIR,
    ]);
    return {
      branch: ARTIFACTS_REPO_BRANCH,
      checkoutDir: ARTIFACTS_REPO_DIR,
      repoUrl: ARTIFACTS_REPO_URL,
    };
  }

  const originUrl = runGitCommand(["remote", "get-url", "origin"], ARTIFACTS_REPO_DIR);
  if (originUrl !== ARTIFACTS_REPO_URL) {
    throw new Error(
      `Artifacts repo checkout at ${ARTIFACTS_REPO_DIR} points to ${originUrl}, expected ${ARTIFACTS_REPO_URL}.`,
    );
  }

  const currentBranch = runGitCommand(["branch", "--show-current"], ARTIFACTS_REPO_DIR);
  if (currentBranch && currentBranch !== ARTIFACTS_REPO_BRANCH) {
    throw new Error(
      `Artifacts repo checkout at ${ARTIFACTS_REPO_DIR} is on branch ${currentBranch}, expected ${ARTIFACTS_REPO_BRANCH}.`,
    );
  }

  runGitCommand(["pull", "--ff-only", "origin", ARTIFACTS_REPO_BRANCH], ARTIFACTS_REPO_DIR);
  return {
    branch: ARTIFACTS_REPO_BRANCH,
    checkoutDir: ARTIFACTS_REPO_DIR,
    repoUrl: ARTIFACTS_REPO_URL,
  };
}

export function syncArtifactToRepo(
  markdown: string,
  slug: string,
  runId: number,
  timestamp = new Date(),
): ArtifactRepoMirrorResult | null {
  const repo = ensureArtifactsRepoCheckout();
  if (!repo) {
    return null;
  }

  const relativePath = artifactRepoRelativePath(slug, timestamp);
  const localPath = resolve(repo.checkoutDir, relativePath);
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, markdown, "utf-8");

  runGitCommand(["add", "--", relativePath], repo.checkoutDir);
  const status = runGitCommand(["status", "--short", "--", relativePath], repo.checkoutDir);

  if (!status) {
    return {
      ...repo,
      commitSha: null,
      localPath,
      pushed: false,
      relativePath,
    };
  }

  runGitCommand(["commit", "-m", `Add artifact ${slug} (run #${runId})`], repo.checkoutDir);
  const commitSha = runGitCommand(["rev-parse", "HEAD"], repo.checkoutDir);
  runGitCommand(["push", "origin", repo.branch], repo.checkoutDir);

  return {
    ...repo,
    commitSha,
    localPath,
    pushed: true,
    relativePath,
  };
}

export function approveResearchRun(
  db: Database.Database,
  runId: number,
  notes: string | null = null,
): {
  obsidianPath: string | null;
  path: string;
  opportunityId: number;
  draft: ResearchDraft;
  repoMirror: ArtifactRepoMirrorResult | null;
} {
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

  const approvedAt = new Date();
  const now = approvedAt.toISOString();
  const path = artifactPath(draft.opportunity_slug, approvedAt);
  mkdirSync(dirname(path), { recursive: true });
  const artifactMarkdown = renderMarkdown(draft, runId, now);
  writeFileSync(path, artifactMarkdown, "utf-8");

  let repoMirror: ArtifactRepoMirrorResult | null = null;
  if (ARTIFACTS_REPO_URL) {
    try {
      repoMirror = syncArtifactToRepo(artifactMarkdown, draft.opportunity_slug, runId, approvedAt);
    } catch (err) {
      recordRunEvent(db, {
        eventType: "export.warning",
        opportunityId,
        payload: {
          export_target: "github_repo",
          repo_branch: ARTIFACTS_REPO_BRANCH,
          repo_checkout_dir: ARTIFACTS_REPO_DIR,
          repo_url: ARTIFACTS_REPO_URL,
          failure: summarizeExecError(err),
        },
        runId,
        stage: "review",
        status: "warning",
        summary: "Artifact approved but GitHub artifact sync failed.",
      });
    }
  }

  let obsidianPath: string | null = null;
  const configuredObsidianPath = obsidianArtifactPath(draft.opportunity_slug, approvedAt);
  if (configuredObsidianPath) {
    try {
      mkdirSync(dirname(configuredObsidianPath), { recursive: true });
      writeFileSync(
        configuredObsidianPath,
        renderObsidianMarkdown(
          draft,
          runId,
          opp.title,
          repoMirror?.localPath ?? path,
          now,
        ),
        "utf-8",
      );
      obsidianPath = configuredObsidianPath;
    } catch (err) {
      recordRunEvent(db, {
        eventType: "export.warning",
        opportunityId,
        payload: {
          export_target: "obsidian",
          failure: err instanceof Error ? err.message : String(err),
          export_path: configuredObsidianPath,
        },
        runId,
        stage: "review",
        status: "warning",
        summary: "Artifact approved but Obsidian export failed.",
      });
    }
  }

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
      obsidian_export_path: obsidianPath,
      repo_mirror_commit_sha: repoMirror?.commitSha ?? null,
      repo_mirror_path: repoMirror?.relativePath ?? null,
      repo_mirror_url: repoMirror?.repoUrl ?? null,
    },
    runId,
    stage: "review",
    status: "ok",
    summary: `Research run #${runId} approved.`,
  });

  return { obsidianPath, path, opportunityId, draft, repoMirror };
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
