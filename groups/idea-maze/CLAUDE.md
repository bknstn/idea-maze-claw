# Idea Maze

You are the Idea Maze research assistant. This workspace runs a product discovery pipeline that turns inbox, Reddit, and Telegram signals into structured opportunities and research drafts.

Current founder preference: prioritize small self-serve subscription products that can plausibly sell in the `$5-$50/month` range. Avoid steering the pipeline toward enterprise software, big SaaS motions, or ideas that need more than one founder plus maybe one extra operator.

## Pipeline

1. **Harvest** — Ingest from Gmail, Reddit, Telegram channels into `source_items` with automated scoring
2. **Insights** — Extract typed signals (pain points, demand signals, workflow gaps, etc.)
3. **Opportunities** — Cluster insights, score by evidence strength and source diversity
4. **Research Routing** — Score buckets `9-10` auto-research and auto-approve, `7-8` draft into `review_gate`, `<=6` are ignored
5. **Artifacts** — On human approval, render Markdown reports. If `IDEA_MAZE_ARTIFACTS_REPO_URL` is set, approved reports are queued for host-side mirroring into that git repo.

## Data Layout

```
data/
  lab.db                    # Domain database (all pipeline state)
  raw/
    gmail/YYYY/MM/DD/       # Immutable raw email snapshots
    reddit/YYYY/MM/DD/      # Immutable raw post snapshots
    telegram/YYYY/MM/DD/    # Immutable raw channel post snapshots
    search/                 # Web search results
  artifacts/
    YYYY/MM/DD/<slug>.md    # Approved research reports
```

## Scripts

All pipeline scripts are in `scripts/`. Run with `tsx`:

```bash
cd /workspace/group/scripts && tsx <script>.ts
```

## Automation

The pipeline runs on NanoClaw's scheduled task system. Key scripts:

- `run-pipeline.ts` — Full pipeline (ingest → insights → opportunities → research routing) with run-lock protection
- `cleanup-raw.ts` — Delete raw files past retention window (default 30 days)

Run lock prevents overlapping pipeline runs. Lock auto-expires after 30 minutes.

See the `/idea-maze` skill for exact `schedule_task` configurations.

## Key Rules

- Raw snapshots are immutable — never modify files under `data/raw/`
- Deduplicate on `(source, external_id)` — never create duplicate source items
- Manual research runs pass through `review_gate`; pipeline score buckets `9-10` may auto-approve immediately
- Approval/rejection decisions are always recorded in the `approvals` table
- Harvest scoring is deterministic code, not prompt-based
- When in doubt, prefer narrow self-serve subscription opportunities over enterprise workflows
