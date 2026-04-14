---
name: idea-maze
description: Run Idea Maze research pipeline — harvest Reddit signals, extract insights, cluster opportunities, and route research by score. Use when the user mentions harvesting, ingesting, insights, opportunities, research pipeline, or scoring.
---

# Idea Maze Research Pipeline

You manage the Idea Maze product discovery pipeline. All domain data lives in `/workspace/group/data/lab.db` (separate from NanoClaw's messages.db).

## Running Scripts

All scripts are at `/workspace/group/scripts/`. Run them with:

```bash
cd /workspace/group/scripts && tsx <script>.ts [args]
```

## Available Scripts

### Database
- `init-db.ts` — Initialize/migrate lab.db schema (safe to re-run)

### Ingestion
- `ingest-reddit.ts` — Harvest from configured subreddits

### Analysis
- `extract-insights.ts` — Extract typed insights from unprocessed source items (LLM + heuristic fallback)
- `refresh-opportunities.ts` — Cluster insights into opportunities by keyword

### Research
- `research-opportunity.ts <slug>` — Draft research for an opportunity (manual runs land in `review_gate`)
- `process-opportunities.ts` — Route scored opportunities: `9-10` auto-approve, `7-8` queue for manual review, `<=6` ignore

### Review Gate
- `approve-run.ts <run_id> [notes]` — Approve a run, write Markdown artifact
- `reject-run.ts <run_id> [notes]` — Reject a run, record decision

## Long-running Operations

Before executing any script that takes more than a few seconds (pipeline, research, insight extraction), **always send an immediate acknowledgment first**:

```
Call mcp__nanoclaw__send_message with text like "⏳ Running pipeline..." before executing the script.
```

This lets the user know the request was received while the work runs.

## Pipeline Stages

1. **Harvest** — Ingest from Reddit → `source_items` with harvest scores
2. **Insights** — Extract typed signals: pain_point, demand_signal, workflow_gap, distribution_clue, willingness_to_pay, competitor_move, implementation_constraint
3. **Opportunities** — Cluster insights by keyword, score by evidence + diversity
4. **Research Routing** — Draft thesis, evidence, MVP scope, risks; `9-10` auto-approve, `7-8` land in `review_gate`, `<=6` ignored
5. **Artifacts** — On approval, render Markdown to `data/artifacts/`

## Data Locations

- Database: `/workspace/group/data/lab.db`
- Raw snapshots: `/workspace/group/data/raw/`
- Artifacts: `/workspace/group/data/artifacts/`

## Quick Status

```bash
cd /workspace/group/scripts && tsx -e "
import { getDb } from './lib/db.ts';
const db = getDb();
const counts = {
  sources: db.prepare('SELECT COUNT(*) as n FROM source_items').get(),
  insights: db.prepare('SELECT COUNT(*) as n FROM insights').get(),
  opportunities: db.prepare('SELECT COUNT(*) as n FROM opportunities').get(),
  pendingRuns: db.prepare(\"SELECT COUNT(*) as n FROM runs WHERE status = 'review_gate'\").get()
};
console.log(JSON.stringify(counts, null, 2));
"
```

## Common Workflows

### Full harvest
```bash
cd /workspace/group/scripts && tsx run-pipeline.ts
```

### Review pending research
```bash
cd /workspace/group/scripts && tsx -e "
import { getDb } from './lib/db.ts';
const db = getDb();
const runs = db.prepare(\"SELECT r.id, r.status, o.title FROM runs r JOIN opportunities o ON o.id = r.target_id WHERE r.status = 'review_gate'\").all();
console.log(JSON.stringify(runs, null, 2));
"
```

## Scheduling

Set up recurring jobs using `mcp__nanoclaw__schedule_task`. All tasks target the idea-maze group.

### Recommended schedule

**Full pipeline** (Reddit ingest + insights + opportunities + research routing) — every 60 minutes:
```
prompt: "Run the active Idea Maze pipeline. Execute: cd /workspace/group/scripts && tsx run-pipeline.ts. Report a concise results summary."
schedule_type: interval
schedule_value: "3600000"
context_mode: isolated
```

**Weekly digest** — Monday at 08:00:
```
prompt: "Generate a weekly digest. Query the top 10 opportunities from lab.db ordered by score. Include title, score, insight count, and top signals. Format as a concise report and send via send_message."
schedule_type: cron
schedule_value: "0 8 * * 1"
context_mode: isolated
```

**Raw cleanup** — daily at 03:00:
```
prompt: "Run raw file cleanup. Execute: cd /workspace/group/scripts && tsx cleanup-raw.ts --days 30"
schedule_type: cron
schedule_value: "0 3 * * *"
context_mode: isolated
script: |
  cd /workspace/group/scripts
  COUNT=$(find /workspace/group/data/raw -name "*.json" -mtime +30 2>/dev/null | wc -l)
  if [ "$COUNT" -eq 0 ]; then
    echo '{"wakeAgent": false}'
  else
    echo '{"wakeAgent": true, "data": {"stale_files": '$COUNT'}}'
  fi
```

### Setting up the schedule

When the user asks to "set up the pipeline schedule" or "start automation", schedule the three jobs above. Use `target_group_jid` if scheduling from the main chat for the idea-maze group.

### Run lock

The pipeline uses a run lock in `app_state` to prevent overlapping runs. `run-pipeline.ts` acquires/releases the lock automatically. Lock expires after 30 minutes as a safety valve.

## Configuration

Pipeline settings are stored in the `app_state` table:

| Key | Example Value | Purpose |
|-----|--------------|---------|
| `reddit_subreddits` | `["SaaS","startups","webdev"]` | Subreddits to harvest |
| `gmail_query` | `newer_than:1d -category:promotions` | Gmail search filter |
| `telegram_channels` | `["channel_username"]` | Telegram channels to follow |
| `opportunity score policy` | `9-10 auto`, `7-8 manual`, `<=6 ignore` | Built-in research routing thresholds |
