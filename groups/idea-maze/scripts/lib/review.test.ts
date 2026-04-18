import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("review flow", () => {
  let groupDir: string;

  beforeEach(() => {
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), "idea-maze-review-"));
    fs.mkdirSync(path.join(groupDir, "data"), { recursive: true });
    process.env.WORKSPACE_GROUP = groupDir;
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeDb } = await import("./db.ts");
    closeDb();
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
