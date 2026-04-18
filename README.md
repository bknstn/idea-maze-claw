# Idea Maze

Idea Maze is a personal product discovery system built around a Reddit-first pipeline. It harvests signals, extracts typed insights, clusters opportunities, runs bounded research, and stores artifacts for review.

This repository is a fork of NanoClaw. NanoClaw provides the underlying chat agent runtime, container isolation, and task scheduling. The README here is intentionally about Idea Maze itself.

## What This Repo Does

- Harvests raw source material from Reddit into `groups/idea-maze/data/lab.db`
- Extracts typed signals such as pain points, demand signals, and workflow gaps
- Clusters signals into opportunities with market and founder-fit scoring
- Routes opportunities through `scored`, `shortlisted`, `researching`, `review_gate`, `approved`, `rejected`, and `archived`
- Produces reviewable research artifacts under `groups/idea-maze/data/artifacts/`
- Can mirror approved artifacts into a dedicated private Git repo for downstream review workflows

Reddit is the active automated source on `main`. Gmail and Telegram ingestors are scaffolded but currently disabled.

## Setup

```bash
git clone <this-repo>
cd idea-maze-claw
npm install
npm run build
claude
```

Inside `claude`, run `/setup` to configure Telegram and OneCLI credentials.

Initialize the Idea Maze database:

```bash
cd groups/idea-maze/scripts
npx tsx init-db.ts
```

Restore the default Idea Maze schedule after setup or a fresh deploy:

```bash
npx tsx scripts/setup-idea-maze-schedule.ts
```

## Pipeline

| Stage | Script | Output |
|------|--------|--------|
| Harvest | `ingest-reddit.ts` | Raw `source_items` and harvest scores |
| Insights | `extract-insights.ts` | Typed signals |
| Opportunities | `refresh-opportunities.ts` | Clustered opportunities with market and taste scoring |
| Processing | `process-opportunities.ts` | Queueing, auto-approval, and review-gate decisions |
| Research | `research-opportunity.ts <slug>` | Draft thesis plus validation log |
| Artifacts | `approve-run.ts <run_id>` | Markdown reports in `data/artifacts/YYYY/MM/DD/` and optional GitHub repo mirror |

Run the scheduled stages manually:

```bash
cd groups/idea-maze/scripts
npx tsx run-pipeline.ts
```

Inspect current state:

```bash
cd groups/idea-maze/scripts
npx tsx pipeline-status.ts
npx tsx explain-opportunity.ts <slug>
```

## Operations

This fork ships directly from `main`.

```bash
npm run verify
npm run ship:vps
```

For a deployed VPS, use:

```bash
./scripts/monitor-vps.sh
./scripts/monitor-vps.sh --follow
```

`npm run ship:vps` runs local verification, pushes `origin/main`, deploys `/root/idea-maze-claw` on `idea-maze-vps`, restarts `nanoclaw`, runs `npx tsx setup/index.ts --step verify` on the VPS, and prints the standard monitor summary.

## Architecture

```text
Telegram -> SQLite -> NanoClaw runtime -> isolated container agent
                                      -> groups/idea-maze/scripts/*.ts
                                      -> groups/idea-maze/data/lab.db
```

Key paths:

- `groups/idea-maze/data/lab.db`: pipeline state
- `groups/idea-maze/data/artifacts/`: approved research outputs
- `groups/idea-maze/data/artifacts-repo/`: default local checkout used for optional artifact repo mirroring
- `groups/idea-maze/scripts/`: ingestion, scoring, research, and observability scripts
- `src/index.ts`: host orchestrator
- `src/task-scheduler.ts`: scheduled task runner
- `src/container-runner.ts`: container execution

Optional artifact mirror config:

- `IDEA_MAZE_ARTIFACTS_REPO_URL`: SSH URL of the private repo that should receive approved artifacts
- `IDEA_MAZE_ARTIFACTS_REPO_BRANCH`: branch to push to, defaults to `main`
- `IDEA_MAZE_ARTIFACTS_REPO_DIR`: optional checkout path override; defaults to `groups/idea-maze/data/artifacts-repo/` inside the active group workspace

## Notes

- Commands prefixed with `/` are Claude Code skills that you run inside the `claude` prompt.
- The main operator channel is Telegram.
- The `idea-maze` group is the dedicated pipeline workspace and stays isolated from the main control chat.

## License

MIT
