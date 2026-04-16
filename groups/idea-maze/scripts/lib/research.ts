import type Database from "better-sqlite3";
import { closeDb, getDb } from "./db.ts";
import { initSchema } from "./schema.ts";
import { isLlmConfigured, generateResearchJson as generateJson } from "./llm.ts";
import { RESEARCH_SYSTEM_PROMPT, buildResearchUserPrompt } from "./prompts.ts";
import {
  enrichOpportunityWithSearch,
  isSearchConfigured,
  type SearchEvidenceItem,
} from "./search.ts";
import { approveResearchRun, type ResearchDraft } from "./review.ts";

interface Logger {
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
}

export interface ResearchOpportunityOptions {
  approvalMode?: "review_gate" | "auto_approve";
  approvalNotes?: string | null;
  db?: Database.Database;
  logger?: Logger;
  requestedBy?: string;
}

export interface ResearchOpportunityResult {
  artifactPath?: string;
  opportunityId: number;
  opportunitySlug: string;
  runId: number;
  status: "approved" | "review_gate";
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
}

async function buildLlmDraft(
  opp: { slug: string; title: string; thesis: string },
  sourceItems: any[],
  searchItems: SearchEvidenceItem[],
  searchAnswers: string[],
): Promise<Omit<ResearchDraft, "opportunity_slug" | "source_refs">> {
  const inbox = sourceItems.filter((s) => s.source === "gmail").slice(0, 5).map((s: any) => `${s.id}: ${s.text.slice(0, 220)}`);
  const telegram = sourceItems.filter((s) => s.source === "telegram").slice(0, 5).map((s: any) => `${s.id}: ${s.text.slice(0, 220)}`);
  const reddit = sourceItems.filter((s) => s.source === "reddit").slice(0, 5).map((s: any) => `${s.id}: ${s.text.slice(0, 220)}`);
  const external = searchItems.slice(0, 5).map((s) => s.title || s.text.slice(0, 180));

  const prompt = buildResearchUserPrompt({
    slug: opp.slug,
    title: opp.title,
    thesis: opp.thesis,
    inbox_evidence: inbox,
    telegram_evidence: telegram,
    reddit_evidence: reddit,
    external_research: external,
    search_synthesis: searchAnswers,
  });

  return generateJson<Omit<ResearchDraft, "opportunity_slug" | "source_refs">>(
    RESEARCH_SYSTEM_PROMPT,
    prompt,
  );
}

function buildTemplateDraft(
  opp: { slug: string; title: string; thesis: string; cluster_key: string },
  sourceItems: any[],
  searchItems: SearchEvidenceItem[],
): Omit<ResearchDraft, "opportunity_slug" | "source_refs"> {
  const inbox = sourceItems.filter((s) => s.source === "gmail").slice(0, 5).map((s: any) => s.text.slice(0, 220));
  const telegram = sourceItems.filter((s) => s.source === "telegram").slice(0, 5).map((s: any) => s.text.slice(0, 220));
  const reddit = sourceItems.filter((s) => s.source === "reddit").slice(0, 5).map((s: any) => s.text.slice(0, 220));
  const external = searchItems.slice(0, 5).map((s) => s.title || s.text.slice(0, 180));

  return {
    thesis: opp.thesis,
    evidence_from_inbox: inbox.length ? inbox : ["None"],
    evidence_from_telegram: telegram.length ? telegram : ["None"],
    evidence_from_reddit: reddit.length ? reddit : ["None"],
    external_market_check: external.length ? external : ["None"],
    product_concept: `Build a narrow web app focused on '${opp.cluster_key}' that turns recurring signals into a repeatable workflow.`,
    mvp_scope: [
      "Capture the narrowest workflow around the detected pain point.",
      "Provide one opinionated dashboard or automation path.",
      "Instrument activation and retention from day one.",
    ],
    implementation_plan: [
      "Define one primary user persona and one dominant job-to-be-done.",
      "Build the narrowest functional slice that proves repeated usage.",
      "Ship analytics, feedback capture, and a pricing experiment early.",
    ],
    distribution_plan: [
      "Publish the thesis in the communities where the signal originated.",
      "Use the relevant Telegram, Reddit, or email-derived channel as the first distribution wedge.",
      "Track response quality and inbound follow-up questions as validation.",
    ],
    risks: [
      "Signals may reflect noise rather than durable demand.",
      "The market may already have stronger incumbents.",
      "Inbox and channel evidence may over-index on your current network.",
    ],
    decision_for_human_review: "Approve only if the idea is specific enough to build in one narrow iteration.",
  };
}

export async function researchOpportunity(
  target: string,
  options: ResearchOpportunityOptions = {},
): Promise<ResearchOpportunityResult> {
  if (!target) {
    throw new Error("Usage: tsx research-opportunity.ts <slug-or-topic>");
  }

  const ownsDb = !options.db;
  const db = options.db ?? getDb();
  const logger = options.logger ?? console;
  const approvalMode = options.approvalMode ?? "review_gate";
  const requestedBy = options.requestedBy ?? "user";
  let runId: number | null = null;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  initSchema(db);

  const markRunFailed = (reason: string): void => {
    if (runId === null) return;
    db.prepare(`
      UPDATE runs
      SET status = 'error', completed_at_utc = ?, error = ?
      WHERE id = ? AND status IN ('running', 'review_gate')
    `).run(new Date().toISOString(), reason, runId);
  };

  const installSignalHandler = (signal: NodeJS.Signals, exitCode: number): void => {
    const handler = () => {
      try {
        markRunFailed(`Interrupted by ${signal}`);
      } finally {
        process.exit(exitCode);
      }
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  };

  const removeSignalHandlers = (): void => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
  };

  try {
    let opp = db.prepare("SELECT * FROM opportunities WHERE slug = ?").get(target) as any;
    if (!opp) {
      const slug = slugify(target);
      opp = db.prepare("SELECT * FROM opportunities WHERE slug = ?").get(slug) as any;
      if (!opp) {
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO opportunities (slug, title, thesis, score, status, cluster_key, metadata_json, created_at_utc, updated_at_utc)
          VALUES (?, ?, ?, 1.0, 'active', ?, '{"ad_hoc": true}', ?, ?)
        `).run(slug, target.trim(), `Investigate whether '${target}' could become a focused web product.`, slug, now, now);
        opp = db.prepare("SELECT * FROM opportunities WHERE slug = ?").get(slug) as any;
        logger.log(`Created ad-hoc opportunity: ${slug}`);
      }
    }

    logger.log(`Researching: ${opp.title} (${opp.slug})`);

    const now = new Date().toISOString();
    const runResult = db.prepare(`
      INSERT INTO runs (run_type, target_type, target_id, status, requested_by, started_at_utc, metadata_json)
      VALUES ('research', 'opportunity', ?, 'running', ?, ?, '{}')
    `).run(String(opp.id), requestedBy, now);
    runId = Number(runResult.lastInsertRowid);
    logger.log(`Created run #${runId}`);
    installSignalHandler("SIGINT", 130);
    installSignalHandler("SIGTERM", 143);

    const sourceItems = db.prepare(`
      SELECT si.* FROM source_items si
      JOIN opportunity_sources os ON os.source_item_id = si.id
      WHERE os.opportunity_id = ?
      ORDER BY json_extract(si.metadata_json, '$.harvest_score') DESC, si.timestamp_utc DESC
    `).all(opp.id) as any[];
    logger.log(`Found ${sourceItems.length} linked source items.`);

    let searchItems: SearchEvidenceItem[] = [];
    let searchAnswers: string[] = [];
    let searchTrace: {
      provider: string;
      queries: string[];
      answers: string[];
      result_count: number;
      source_item_ids: number[];
    } | null = null;

    if (isSearchConfigured()) {
      try {
        const enrichment = await enrichOpportunityWithSearch(
          { title: opp.title, cluster_key: opp.cluster_key },
          sourceItems,
          runId,
        );
        searchItems = enrichment.items;
        searchAnswers = enrichment.answers;
        searchTrace = {
          provider: enrichment.provider,
          queries: enrichment.queries,
          answers: enrichment.answers,
          result_count: enrichment.items.length,
          source_item_ids: enrichment.item_ids,
        };
        const answerNote = searchAnswers.length ? `, ${searchAnswers.length} synthesized answer(s)` : "";
        logger.log(
          `Search enrichment: ${searchItems.length} result(s) across ${enrichment.queries.length} quer${enrichment.queries.length === 1 ? "y" : "ies"}${answerNote}.`,
        );
      } catch (err) {
        logger.warn(`Search enrichment failed, continuing without external research: ${err}`);
      }
    } else {
      logger.log("No TAVILY_API_KEY — skipping web enrichment.");
    }

    let draftBody: Omit<ResearchDraft, "opportunity_slug" | "source_refs">;
    if (isLlmConfigured()) {
      try {
        logger.log("Building draft via LLM...");
        draftBody = await buildLlmDraft(opp, sourceItems, searchItems, searchAnswers);
      } catch (err) {
        logger.warn(`LLM draft failed, using template: ${err}`);
        draftBody = buildTemplateDraft(opp, sourceItems, searchItems);
      }
    } else {
      logger.log("No ANTHROPIC_API_KEY — using template draft.");
      draftBody = buildTemplateDraft(opp, sourceItems, searchItems);
    }

    const draft: ResearchDraft = {
      opportunity_slug: opp.slug,
      ...draftBody,
      source_refs: [...new Set([...sourceItems.map((s: any) => s.id), ...searchItems.map((s) => s.id)])],
    };

    db.prepare("UPDATE runs SET status = 'review_gate', metadata_json = ? WHERE id = ?").run(
      JSON.stringify({
        draft,
        research_trace: {
          source_item_count: sourceItems.length,
          external_search: searchTrace,
        },
      }),
      runId,
    );

    if (approvalMode === "auto_approve") {
      const { path } = approveResearchRun(db, runId, options.approvalNotes ?? null);
      logger.log(`Run #${runId} auto-approved.`);
      logger.log(`Artifact written: ${path}`);
      return {
        artifactPath: path,
        opportunityId: Number(opp.id),
        opportunitySlug: opp.slug,
        runId,
        status: "approved",
      };
    }

    db.prepare("UPDATE opportunities SET last_reviewed_at_utc = ? WHERE id = ?").run(
      new Date().toISOString(),
      opp.id,
    );

    logger.log(`Run #${runId} moved to review_gate.`);
    logger.log("Thesis:", draft.thesis.slice(0, 200));
    logger.log(`To approve: tsx approve-run.ts ${runId}`);
    logger.log(`To reject:  tsx reject-run.ts ${runId}`);

    return {
      opportunityId: Number(opp.id),
      opportunitySlug: opp.slug,
      runId,
      status: "review_gate",
    };
  } catch (err) {
    if (runId !== null) {
      markRunFailed(err instanceof Error ? err.message : String(err));
    }
    throw err;
  } finally {
    removeSignalHandlers();
    if (ownsDb) {
      closeDb();
    }
  }
}
