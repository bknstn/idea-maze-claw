import type Database from "better-sqlite3";

import { getCounts } from "./queries.ts";
import { computeTasteForOpportunity, extractOpportunityFeatures } from "./taste.ts";

function parseJson(value: string): Record<string, any> {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function buildPipelineStatusReport(db: Database.Database): string {
  const latestRun = db.prepare(`
    SELECT id, status, started_at_utc, completed_at_utc, error
    FROM runs
    WHERE run_type = 'pipeline'
    ORDER BY started_at_utc DESC
    LIMIT 1
  `).get() as
    | {
      completed_at_utc: string | null;
      error: string | null;
      id: number;
      started_at_utc: string;
      status: string;
    }
    | undefined;
  const counts = getCounts();
  const activeOpportunities = (db.prepare("SELECT COUNT(*) as n FROM opportunities WHERE status = 'active'").get() as any).n;
  const archivedOpportunities = (db.prepare("SELECT COUNT(*) as n FROM opportunities WHERE status = 'archived'").get() as any).n;

  const stageEvents = latestRun
    ? db.prepare(`
      SELECT stage, status, summary, payload_json, created_at_utc
      FROM run_events
      WHERE run_id = ?
        AND event_type IN ('pipeline.stage_completed', 'pipeline.stage_failed')
      ORDER BY created_at_utc ASC
    `).all(latestRun.id) as Array<{
      created_at_utc: string;
      payload_json: string;
      stage: string | null;
      status: string;
      summary: string;
    }>
    : [];

  const recentWarnings = db.prepare(`
    SELECT run_id, stage, status, summary, payload_json, created_at_utc
    FROM run_events
    WHERE status IN ('warning', 'error')
    ORDER BY created_at_utc DESC
    LIMIT 5
  `).all() as Array<{
    created_at_utc: string;
    payload_json: string;
    run_id: number | null;
    stage: string | null;
    status: string;
    summary: string;
  }>;

  const lines = [
    latestRun
      ? `Latest pipeline run: #${latestRun.id} [${latestRun.status}] ${latestRun.started_at_utc}`
      : "Latest pipeline run: none recorded",
    latestRun?.completed_at_utc ? `Completed: ${latestRun.completed_at_utc}` : "Completed: still running or unavailable",
    latestRun?.error ? `Error: ${latestRun.error}` : "Error: none",
    "",
    `Counts: ${counts.source_items} sources, ${counts.insights} insights, ${counts.opportunities} opportunities, ${activeOpportunities} active, ${archivedOpportunities} archived, ${counts.runs_pending} pending runs`,
    "",
    "Stages:",
  ];

  if (!stageEvents.length) {
    lines.push("- No stage events recorded.");
  } else {
    for (const event of stageEvents) {
      const payload = parseJson(event.payload_json);
      const duration = payload.duration_ms ? ` (${payload.duration_ms}ms)` : "";
      lines.push(`- ${event.stage ?? "unknown"}: ${event.status}${duration} — ${event.summary}`);
    }
  }

  lines.push("", "Recent warnings:");
  if (!recentWarnings.length) {
    lines.push("- No recent warnings or errors.");
  } else {
    for (const warning of recentWarnings) {
      const payload = parseJson(warning.payload_json);
      const failureClass = payload.failure_class ? ` [${payload.failure_class}]` : "";
      lines.push(`- run #${warning.run_id ?? "n/a"} ${warning.stage ?? "unknown"} ${warning.status}${failureClass}: ${warning.summary}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function buildOpportunityExplanation(
  db: Database.Database,
  slug: string,
): string {
  const opportunity = db.prepare(`
    SELECT *
    FROM opportunities
    WHERE slug = ?
  `).get(slug) as
    | {
      cluster_key: string;
      final_score: number;
      id: number;
      lifecycle_stage: string;
      market_score: number;
      metadata_json: string;
      score: number;
      slug: string;
      status: string;
      taste_adjustment: number;
      thesis: string;
      title: string;
    }
    | undefined;
  if (!opportunity) {
    throw new Error(`Opportunity '${slug}' not found.`);
  }

  const metadata = parseJson(opportunity.metadata_json);
  const taste = computeTasteForOpportunity(
    db,
    opportunity.id,
    Number(opportunity.market_score) || Number(opportunity.score) || 0,
  );
  const features = extractOpportunityFeatures(db, opportunity.id);
  const sourceSummary = db.prepare(`
    SELECT source, COUNT(*) as n
    FROM source_items si
    JOIN opportunity_sources os ON os.source_item_id = si.id
    WHERE os.opportunity_id = ?
    GROUP BY source
    ORDER BY n DESC, source ASC
  `).all(opportunity.id) as Array<{ n: number; source: string }>;
  const reviewHistory = db.prepare(`
    SELECT a.decision, a.notes, a.decided_at_utc
    FROM approvals a
    JOIN runs r ON r.id = a.run_id
    WHERE r.target_type = 'opportunity'
      AND CAST(r.target_id AS INTEGER) = ?
    ORDER BY a.decided_at_utc DESC
  `).all(opportunity.id) as Array<{ decided_at_utc: string; decision: string; notes: string | null }>;

  const lines = [
    `${opportunity.title} (${opportunity.slug})`,
    `Lifecycle: ${opportunity.lifecycle_stage} | Status: ${opportunity.status}`,
    `Scores: market=${opportunity.market_score} taste=${opportunity.taste_adjustment} final=${opportunity.final_score}`,
    `Cluster: ${opportunity.cluster_key}`,
    `Thesis: ${opportunity.thesis}`,
    "",
    "Evidence:",
    `- Insights: ${metadata.insight_count ?? 0}`,
    `- Sources: ${metadata.source_count ?? 0} (${sourceSummary.map((row) => `${row.source}:${row.n}`).join(", ") || "none"})`,
    `- Top source patterns: ${(metadata.top_source_patterns ?? []).join(", ") || "none"}`,
    `- Top harvest signals: ${(metadata.top_harvest_signals ?? []).join(", ") || "none"}`,
    "",
    "Taste match:",
    `- Type scores: cluster=${taste.typeScores.cluster_key}, source_pattern=${taste.typeScores.source_pattern}, harvest_signal=${taste.typeScores.harvest_signal}, insight_type=${taste.typeScores.insight_type}, source_origin=${taste.typeScores.source_origin}`,
    `- Matched features: ${taste.matchedFeatures.map((feature) => `${feature.featureType}:${feature.featureValue}=${feature.learnedWeight}`).join(", ") || "none"}`,
    "",
    "Feature snapshot:",
    `- cluster_key: ${features.cluster_key.join(", ") || "none"}`,
    `- source_pattern: ${features.source_pattern.join(", ") || "none"}`,
    `- harvest_signal: ${features.harvest_signal.join(", ") || "none"}`,
    `- insight_type: ${features.insight_type.join(", ") || "none"}`,
    `- source_origin: ${features.source_origin.join(", ") || "none"}`,
    "",
    "Review history:",
  ];

  if (!reviewHistory.length) {
    lines.push("- No approvals or rejections recorded.");
  } else {
    for (const review of reviewHistory) {
      lines.push(`- ${review.decided_at_utc}: ${review.decision}${review.notes ? ` — ${review.notes}` : ""}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
