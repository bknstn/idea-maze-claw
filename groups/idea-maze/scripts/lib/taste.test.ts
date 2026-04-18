import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("founder-fit scoring", () => {
  let groupDir: string;

  beforeEach(() => {
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), "idea-maze-taste-"));
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

  it("raises and lowers future ranking from review decisions without changing market score", async () => {
    const { getDb } = await import("./db.ts");
    const { initSchema } = await import("./schema.ts");
    const { recomputeOpportunityScore, updateTasteProfileFromDecision } = await import("./taste.ts");

    const db = getDb();
    initSchema(db);

    const insertOpportunity = db.prepare(`
      INSERT INTO opportunities (
        id, slug, title, thesis, score, market_score, final_score, status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'shortlisted', ?, '{}', ?, ?)
    `);
    const insertRun = db.prepare(`
      INSERT INTO runs (id, run_type, target_type, target_id, status, requested_by, started_at_utc, metadata_json)
      VALUES (?, 'research', 'opportunity', ?, 'approved', 'system', ?, '{}')
    `);
    const insertSource = db.prepare(`
      INSERT INTO source_items (
        id, source, external_id, text, timestamp_utc, ingested_at_utc, raw_path, content_hash, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertInsight = db.prepare(`
      INSERT INTO insights (id, source_item_id, insight_type, summary, evidence_score, confidence, status, metadata_json, created_at_utc)
      VALUES (?, ?, ?, ?, 0.8, 0.8, 'new', '{}', ?)
    `);
    const link = db.prepare(`
      INSERT INTO opportunity_sources (opportunity_id, source_item_id)
      VALUES (?, ?)
    `);

    insertOpportunity.run(1, "invoice-reconciliation-a", "Invoice Reconciliation A", "Painful invoices", 7.5, 7.5, 7.5, "invoice-reconciliation", "2026-04-15T06:00:00.000Z", "2026-04-15T06:00:00.000Z");
    insertOpportunity.run(2, "invoice-reconciliation-b", "Invoice Reconciliation B", "Still painful invoices", 7.5, 7.5, 7.5, "invoice-reconciliation", "2026-04-15T06:00:00.000Z", "2026-04-15T06:00:00.000Z");

    insertRun.run(1, "1", "2026-04-15T06:10:00.000Z");
    insertRun.run(2, "1", "2026-04-15T07:10:00.000Z");

    insertSource.run(
      1,
      "reddit",
      "reddit-1",
      "Teams keep reconciling invoices by hand.",
      "2026-04-15T06:00:00.000Z",
      "2026-04-15T06:00:00.000Z",
      "/tmp/source-1.json",
      "hash-1",
      JSON.stringify({ harvest_signals: ["manual-work"], source_patterns: ["templates-and-ops"] }),
    );
    insertSource.run(
      2,
      "reddit",
      "reddit-2",
      "Teams still reconcile invoices by hand.",
      "2026-04-15T06:05:00.000Z",
      "2026-04-15T06:05:00.000Z",
      "/tmp/source-2.json",
      "hash-2",
      JSON.stringify({ harvest_signals: ["manual-work"], source_patterns: ["templates-and-ops"] }),
    );
    insertInsight.run(1, 1, "workflow_gap", "Manual reconciliation causes approval delays.", "2026-04-15T06:00:00.000Z");
    insertInsight.run(2, 2, "workflow_gap", "Manual reconciliation keeps the workflow stuck.", "2026-04-15T06:05:00.000Z");
    link.run(1, 1);
    link.run(2, 2);

    updateTasteProfileFromDecision(db, {
      decision: "approved",
      opportunityId: 1,
      runId: 1,
    });
    const boosted = recomputeOpportunityScore(db, 2, 7.5);

    updateTasteProfileFromDecision(db, {
      decision: "rejected",
      opportunityId: 1,
      runId: 2,
    });
    const reduced = recomputeOpportunityScore(db, 2, 7.5);

    expect(boosted.marketScore).toBe(7.5);
    expect(boosted.tasteAdjustment).toBeGreaterThan(0);
    expect(boosted.finalScore).toBeGreaterThan(7.5);

    expect(reduced.marketScore).toBe(7.5);
    expect(reduced.tasteAdjustment).toBeLessThan(boosted.tasteAdjustment);
    expect(reduced.finalScore).toBeLessThan(boosted.finalScore);
  });
});
