import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approveResearchRun: vi.fn(),
  generateResearchJson: vi.fn(),
}));

vi.mock("./llm.ts", () => ({
  RESEARCH_MODEL: "claude-sonnet-4-6",
  generateResearchJson: mocks.generateResearchJson,
  isLlmConfigured: () => true,
}));

vi.mock("./review.ts", () => ({
  approveResearchRun: mocks.approveResearchRun,
}));

describe("researchOpportunity", () => {
  let groupDir: string;

  beforeEach(() => {
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), "idea-maze-research-"));
    fs.mkdirSync(path.join(groupDir, "data"), { recursive: true });
    process.env.WORKSPACE_GROUP = groupDir;
    vi.resetModules();
    mocks.generateResearchJson.mockReset();
    mocks.approveResearchRun.mockReset();
  });

  afterEach(async () => {
    const { closeDb } = await import("./db.ts");
    closeDb();
    delete process.env.WORKSPACE_GROUP;
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it("marks the run as error when auto-approval fails after the run starts", async () => {
    mocks.generateResearchJson.mockResolvedValue({
      thesis: "T",
      evidence_from_inbox: ["None"],
      evidence_from_telegram: ["None"],
      evidence_from_reddit: ["None"],
      external_market_check: ["None"],
      product_concept: "P",
      mvp_scope: ["MVP"],
      implementation_plan: ["Plan"],
      distribution_plan: ["Dist"],
      risks: ["Risk"],
      decision_for_human_review: "Approve",
    });
    mocks.approveResearchRun.mockImplementation(() => {
      throw new Error("approve failed");
    });

    const { getDb } = await import("./db.ts");
    const { initSchema } = await import("./schema.ts");
    const { researchOpportunity } = await import("./research.ts");

    const db = getDb();
    initSchema(db);

    db.prepare(`
      INSERT INTO opportunities (slug, title, thesis, score, status, cluster_key, metadata_json, created_at_utc, updated_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "span-comments",
      "Span Comments",
      "AI agents need clearer specs.",
      10,
      "active",
      "span-comments",
      "{}",
      "2026-04-15T06:00:00.000Z",
      "2026-04-15T06:00:00.000Z",
    );

    await expect(
      researchOpportunity("span-comments", {
        approvalMode: "auto_approve",
        db,
        logger: { log() {}, warn() {} },
        requestedBy: "system",
      }),
    ).rejects.toThrow("approve failed");

    const run = db.prepare(`
      SELECT status, completed_at_utc, error
      FROM runs
      ORDER BY id DESC
      LIMIT 1
    `).get() as { completed_at_utc: string | null; error: string | null; status: string };

    expect(run.status).toBe("error");
    expect(run.completed_at_utc).not.toBeNull();
    expect(run.error).toContain("approve failed");
  });

  it("falls back to a template draft when the LLM draft request fails", async () => {
    mocks.generateResearchJson.mockRejectedValue(
      new Error("Anthropic API request timed out after 120000ms"),
    );

    const { getDb } = await import("./db.ts");
    const { initSchema } = await import("./schema.ts");
    const { researchOpportunity } = await import("./research.ts");

    const db = getDb();
    initSchema(db);

    db.prepare(`
      INSERT INTO opportunities (slug, title, thesis, score, status, cluster_key, metadata_json, created_at_utc, updated_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "finance-ops",
      "Finance Ops",
      "Teams keep reconciling invoices by hand.",
      8,
      "active",
      "finance-ops",
      "{}",
      "2026-04-15T06:00:00.000Z",
      "2026-04-15T06:00:00.000Z",
    );

    const result = await researchOpportunity("finance-ops", {
      db,
      logger: { log() {}, warn() {} },
      requestedBy: "system",
    });

    expect(result.status).toBe("review_gate");

    const run = db.prepare(`
      SELECT status, metadata_json, error
      FROM runs
      ORDER BY id DESC
      LIMIT 1
    `).get() as { error: string | null; metadata_json: string; status: string };

    const metadata = JSON.parse(run.metadata_json) as {
      draft: {
        product_concept: string;
        thesis: string;
      };
      prompt_metadata: {
        validation_status: string;
      };
    };

    expect(run.status).toBe("review_gate");
    expect(run.error).toBeNull();
    expect(metadata.draft.thesis).toBe("Teams keep reconciling invoices by hand.");
    expect(metadata.draft.product_concept).toContain("finance-ops");
    expect(metadata.prompt_metadata.validation_status).toBe("fallback_template");
  });
});
