import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock, readEnvFileMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  readEnvFileMock: vi.fn(() => ({})),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock("../../../../src/env.ts", () => ({
  readEnvFile: readEnvFileMock,
}));

describe("review flow", () => {
  let groupDir: string;

  beforeEach(() => {
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), "idea-maze-review-"));
    fs.mkdirSync(path.join(groupDir, "data"), { recursive: true });
    process.env.WORKSPACE_GROUP = groupDir;
    delete process.env.IDEA_MAZE_ARTIFACTS_REPO_BRANCH;
    delete process.env.IDEA_MAZE_ARTIFACTS_REPO_DIR;
    delete process.env.IDEA_MAZE_ARTIFACTS_REPO_URL;
    vi.resetModules();
    execFileSyncMock.mockReset();
    readEnvFileMock.mockReset();
    readEnvFileMock.mockReturnValue({});
  });

  afterEach(async () => {
    const { closeDb } = await import("./db.ts");
    closeDb();
    delete process.env.IDEA_MAZE_ARTIFACTS_REPO_BRANCH;
    delete process.env.IDEA_MAZE_ARTIFACTS_REPO_DIR;
    delete process.env.IDEA_MAZE_ARTIFACTS_REPO_URL;
    delete process.env.IDEA_MAZE_OBSIDIAN_EXPORT_DIR;
    delete process.env.WORKSPACE_GROUP;
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  async function seedReviewableRun() {
    const { getDb } = await import("./db.ts");
    const { initSchema } = await import("./schema.ts");
    const db = getDb();
    initSchema(db);

    db.prepare(`
      INSERT INTO opportunities (
        id, slug, title, thesis, score, market_score, final_score, status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc
      )
      VALUES (1, 'finance-ops', 'Finance Ops', 'Invoice pain', 8, 8, 8, 'active', 'review_gate', 'finance-ops', '{}', '2026-04-15T06:00:00.000Z', '2026-04-15T06:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO source_items (
        id, source, external_id, text, timestamp_utc, ingested_at_utc, raw_path, content_hash, metadata_json
      )
      VALUES (1, 'reddit', 'reddit-1', 'Teams keep reconciling invoices by hand.', '2026-04-15T06:00:00.000Z', '2026-04-15T06:00:00.000Z', '/tmp/source.json', 'hash-1', ?)
    `).run(JSON.stringify({ harvest_signals: ["manual-work"], source_patterns: ["templates-and-ops"] }));
    db.prepare(`
      INSERT INTO insights (id, source_item_id, insight_type, summary, evidence_score, confidence, status, metadata_json, created_at_utc)
      VALUES (1, 1, 'workflow_gap', 'Manual reconciliation causes delays.', 0.8, 0.8, 'new', '{}', '2026-04-15T06:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO opportunity_sources (opportunity_id, source_item_id)
      VALUES (1, 1)
    `).run();
    db.prepare(`
      INSERT INTO runs (id, run_type, target_type, target_id, status, requested_by, started_at_utc, metadata_json)
      VALUES (1, 'research', 'opportunity', '1', 'review_gate', 'system', '2026-04-15T06:10:00.000Z', ?)
    `).run(JSON.stringify({
      draft: {
        opportunity_slug: "finance-ops",
        thesis: "Invoice reconciliation is painful.",
        evidence_from_inbox: ["None"],
        evidence_from_telegram: ["None"],
        evidence_from_reddit: ["Manual reconciliation keeps showing up."],
        external_market_check: ["None"],
        product_concept: "Finance ops workflow app",
        mvp_scope: ["Core workflow"],
        implementation_plan: ["Ship the narrow slice"],
        distribution_plan: ["Finance ops communities"],
        risks: ["Incumbents"],
        decision_for_human_review: "Approve if narrow enough.",
        source_refs: [1],
      },
    }));

    return db;
  }

  it("records approval feedback, lifecycle, and audit events", async () => {
    const db = await seedReviewableRun();
    const { approveResearchRun } = await import("./review.ts");

    approveResearchRun(db, 1, "Strong fit");

    const opportunity = db.prepare(`
      SELECT lifecycle_stage
      FROM opportunities
      WHERE id = 1
    `).get() as { lifecycle_stage: string };
    const feedbackCount = (db.prepare("SELECT COUNT(*) as n FROM feedback_features").get() as any).n;
    const reviewEvent = db.prepare(`
      SELECT summary
      FROM run_events
      WHERE run_id = 1 AND event_type = 'review.approved'
      LIMIT 1
    `).get() as { summary: string } | undefined;

    expect(opportunity.lifecycle_stage).toBe("approved");
    expect(feedbackCount).toBeGreaterThan(0);
    expect(reviewEvent?.summary).toContain("approved");
  });

  it("mirrors approved artifacts into an Obsidian export directory when configured", async () => {
    const obsidianDir = path.join(groupDir, "obsidian-vault", "Idea Maze");
    process.env.IDEA_MAZE_OBSIDIAN_EXPORT_DIR = obsidianDir;
    vi.resetModules();

    const db = await seedReviewableRun();
    const { approveResearchRun } = await import("./review.ts");

    const { obsidianPath, path: artifactPath } = approveResearchRun(db, 1, "Strong fit");

    expect(obsidianPath).toBeTruthy();
    expect(obsidianPath?.startsWith(obsidianDir)).toBe(true);

    const obsidianBody = fs.readFileSync(obsidianPath!, "utf-8");
    expect(obsidianBody).toContain('title: "Finance Ops"');
    expect(obsidianBody).toContain(`canonical_artifact_path: ${JSON.stringify(artifactPath)}`);
    expect(obsidianBody).toContain("# Finance Ops");
    expect(obsidianBody).toContain("_Mirrored from the approved NanoClaw artifact._");
  });

  it("pushes approved artifacts to the configured GitHub repo mirror", async () => {
    process.env.IDEA_MAZE_ARTIFACTS_REPO_URL = "git@github.com:bknstn/idea-maze-artifacts.git";
    const gitCalls: Array<{ args: string[] }> = [];
    execFileSyncMock.mockImplementation((_command: string, args?: readonly string[]) => {
      const argv = [...(args ?? [])];
      gitCalls.push({ args: argv });

      if (argv[0] === "clone") return "";
      if (argv[2] === "add") return "";
      if (argv[2] === "status") return "A  2026/04/18/finance-ops.md\n";
      if (argv[2] === "commit") return "[main abc1234] Add artifact finance-ops (run #1)\n";
      if (argv[2] === "rev-parse") return "abc1234567890\n";
      if (argv[2] === "push") return "";
      throw new Error(`Unexpected git command: ${argv.join(" ")}`);
    });

    const db = await seedReviewableRun();
    const { approveResearchRun } = await import("./review.ts");

    const result = approveResearchRun(db, 1, "Strong fit");

    expect(result.repoMirror).toBeTruthy();
    expect(result.repoMirror?.repoUrl).toBe("git@github.com:bknstn/idea-maze-artifacts.git");
    expect(result.repoMirror?.relativePath).toBe("2026/04/18/finance-ops.md");
    expect(result.repoMirror?.pushed).toBe(true);
    expect(result.repoMirror?.commitSha).toBe("abc1234567890");

    const mirroredBody = fs.readFileSync(result.repoMirror!.localPath, "utf-8");
    expect(mirroredBody).toContain("run_id: 1");
    expect(mirroredBody).toContain("opportunity_slug: finance-ops");
    expect(gitCalls.map((call) => call.args.join(" "))).toEqual([
      "clone --branch main --single-branch git@github.com:bknstn/idea-maze-artifacts.git " + path.join(groupDir, "data", "artifacts-repo"),
      "-C " + path.join(groupDir, "data", "artifacts-repo") + " add -- 2026/04/18/finance-ops.md",
      "-C " + path.join(groupDir, "data", "artifacts-repo") + " status --short -- 2026/04/18/finance-ops.md",
      "-C " + path.join(groupDir, "data", "artifacts-repo") + " commit -m Add artifact finance-ops (run #1)",
      "-C " + path.join(groupDir, "data", "artifacts-repo") + " rev-parse HEAD",
      "-C " + path.join(groupDir, "data", "artifacts-repo") + " push origin main",
    ]);
  });

  it("records a warning when GitHub repo sync fails but still approves the run", async () => {
    process.env.IDEA_MAZE_ARTIFACTS_REPO_URL = "git@github.com:bknstn/idea-maze-artifacts.git";
    execFileSyncMock.mockImplementation((_command: string, args?: readonly string[]) => {
      const argv = [...(args ?? [])];
      if (argv[0] === "clone") return "";
      if (argv[2] === "add") return "";
      if (argv[2] === "status") return "A  2026/04/18/finance-ops.md\n";
      if (argv[2] === "commit") return "[main abc1234] Add artifact finance-ops (run #1)\n";
      if (argv[2] === "rev-parse") return "abc1234567890\n";
      if (argv[2] === "push") {
        const error = new Error("push failed") as Error & { stderr: string };
        error.stderr = "remote rejected";
        throw error;
      }
      throw new Error(`Unexpected git command: ${argv.join(" ")}`);
    });

    const db = await seedReviewableRun();
    const { approveResearchRun } = await import("./review.ts");

    const result = approveResearchRun(db, 1, "Strong fit");

    expect(result.repoMirror).toBeNull();

    const opportunity = db.prepare(`
      SELECT lifecycle_stage
      FROM opportunities
      WHERE id = 1
    `).get() as { lifecycle_stage: string };
    const warningEvent = db.prepare(`
      SELECT summary, payload_json
      FROM run_events
      WHERE run_id = 1 AND event_type = 'export.warning'
      LIMIT 1
    `).get() as { payload_json: string; summary: string } | undefined;

    expect(opportunity.lifecycle_stage).toBe("approved");
    expect(warningEvent?.summary).toContain("GitHub artifact sync failed");
    expect(warningEvent?.payload_json).toContain('"export_target":"github_repo"');
  });

  it("records rejection feedback and lifecycle", async () => {
    const db = await seedReviewableRun();
    const { rejectResearchRun } = await import("./review.ts");

    rejectResearchRun(db, 1, "Not founder-fit");

    const opportunity = db.prepare(`
      SELECT lifecycle_stage
      FROM opportunities
      WHERE id = 1
    `).get() as { lifecycle_stage: string };
    const reviewEvent = db.prepare(`
      SELECT summary
      FROM run_events
      WHERE run_id = 1 AND event_type = 'review.rejected'
      LIMIT 1
    `).get() as { summary: string } | undefined;

    expect(opportunity.lifecycle_stage).toBe("rejected");
    expect(reviewEvent?.summary).toContain("rejected");
  });
});
