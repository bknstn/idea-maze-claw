# Idea Maze -> NanoClaw Migration Plan

## Goal

Retire the standalone `idea-maze-lab` Python runtime and move the workflow into a NanoClaw fork.

NanoClaw becomes the control plane:

- Telegram operator interface
- scheduled task execution
- agent runtime and web access
- container isolation

The Idea Maze pipeline remains a first-class domain workflow inside that fork. The current product logic is not replaced by NanoClaw's stock chat schema; it is ported and preserved.

---

## Verified Current Logic To Preserve

Based on the current repository, the migration must keep these behaviors:

- harvest from **Gmail**, **Telegram channels**, and **Reddit**
- write immutable raw snapshots under `data/raw/...`
- normalize all harvested records into `source_items`
- compute and persist `harvest_score`, `harvest_signals`, `source_patterns`, and `harvest_breakdown`
- extract typed `insights` from unprocessed source items
- cluster insights into `opportunities` and link them through `opportunity_sources`
- create `research` runs that pause in `review_gate`
- only write Markdown artifacts after approval
- record approvals and rejections in SQLite
- maintain SQLite FTS indexes for `source_items`, `insights`, and `opportunities`
- support Telegram as the operator surface for harvest, review, approval, and status checks

If any of the items above are intentionally removed, that should be an explicit de-scope, not an accidental regression.

---

## Architecture Decision

Do **not** force Idea Maze state into NanoClaw's built-in `store/messages.db` tables.

NanoClaw's core SQLite schema is for chat routing and orchestration:

- `chats`
- `messages`
- `scheduled_tasks`
- `task_run_logs`
- `registered_groups`
- session/router state

It does **not** provide the current Idea Maze domain model:

- `source_items`
- `insights`
- `opportunities`
- `opportunity_sources`
- `runs`
- `approvals`
- `artifacts`
- Idea Maze FTS tables and triggers

### Recommended target layout

```text
Telegram main chat
      |
NanoClaw fork
      |
      +-- store/messages.db              # NanoClaw control-plane state
      |
      +-- groups/idea-maze/              # dedicated Idea Maze workspace
            +-- CLAUDE.md
            +-- data/lab.db              # Idea Maze domain DB
            +-- data/raw/gmail/
            +-- data/raw/telegram/
            +-- data/raw/reddit/
            +-- data/raw/search/
            +-- data/artifacts/
```

### Why this is the right shape

- keeps NanoClaw internals clean and upgradeable
- preserves the existing Idea Maze schema almost 1:1
- uses NanoClaw group filesystem isolation the way NanoClaw is designed
- avoids abusing the `messages` table as a generic source-ingestion store
- makes backup and cutover straightforward

---

## Migration Principles

1. NanoClaw is the runtime and operator shell, not the replacement for the Idea Maze data model.
2. Deterministic logic should be moved into code, not left only as prompt text.
3. Skills should orchestrate the workflow, but persistence, scoring, dedupe, and artifact rendering should live in TypeScript modules/scripts in the fork.
4. Preserve raw snapshots and approval gating exactly; these are core workflow guarantees.
5. Do not cut over until NanoClaw reproduces the current end-to-end path with real data.

---

## Phase 1 - Fork, Setup, and Operator Chat

**Goal:** get a working NanoClaw fork with Telegram as the control channel.

### Steps

1. Fork `qwibitai/nanoclaw` and clone it.
2. Run `claude`, then run `/setup`.
3. Run `/add-telegram`.
4. Register your main Telegram chat with NanoClaw.
5. Recommended: create a dedicated registered chat or group for Idea Maze so it gets its own `groups/idea-maze/` filesystem. Keep the main chat for admin control.

### Done when

- Telegram messages reach NanoClaw successfully
- you can trigger the assistant from Telegram
- NanoClaw has a dedicated Idea Maze workspace folder

---

## Phase 2 - Port the Idea Maze Storage Layer

**Goal:** recreate the current SQLite-first domain model inside the NanoClaw fork.

### Required work

Create TypeScript modules and an init/migration script for `groups/idea-maze/data/lab.db` with the current logical schema:

- `source_items`
- `insights`
- `opportunities`
- `opportunity_sources`
- `runs`
- `approvals`
- `artifacts`
- `app_state`

Also recreate:

- FTS5 tables for `source_items`, `insights`, and `opportunities`
- update triggers for those FTS tables
- storage directories under `groups/idea-maze/data/raw/` and `groups/idea-maze/data/artifacts/`

### Important decision

Keep the Idea Maze DB separate from NanoClaw's `store/messages.db`.

### Done when

- `groups/idea-maze/data/lab.db` can be initialized on a clean machine
- all tables and FTS indexes exist
- raw/artifact directories are created automatically

---

## Phase 3 - Port Ingestion Connectors

**Goal:** restore source parity with the current repo.

### 3A. Gmail ingestion

Use `/add-gmail` in **tool-only mode**, not channel mode.

Reason:

- the current system batch-harvests Gmail inbox items
- it does not treat email threads as a conversational channel
- channel mode would change the product behavior unnecessarily

Build a custom `$ingest-gmail` workflow that:

- queries Gmail using the existing query semantics
- writes raw message payloads to `groups/idea-maze/data/raw/gmail/`
- normalizes fields into `source_items`
- preserves:
  - `external_id`
  - `thread_ref`
  - `author`
  - `title`
  - `text`
  - labels / metadata
  - `timestamp_utc`
  - `raw_path`
  - `content_hash`

### 3B. Telegram channel ingestion

Keep `/add-telegram` only for operator interaction.

Build a custom `$ingest-telegram-channels` workflow for the existing user-session behavior:

- read followed channel posts via Telethon or an equivalent user-auth flow
- keep the existing allowlist behavior
- write raw records to `groups/idea-maze/data/raw/telegram/`
- normalize views, forwards, reply counts, links, and usernames into `source_items.metadata_json`

### 3C. Reddit ingestion

The current pipeline includes Reddit. The migration plan must keep it unless explicitly dropped.

Build `$ingest-reddit` that:

- reads configured subreddits
- prefers JSON endpoints
- falls back to RSS/Atom when needed
- preserves subreddit, score, comment count, upvote ratio, NSFW filtering, and canonical URLs
- writes raw payloads to `groups/idea-maze/data/raw/reddit/`

### Ingestion rules that must survive the port

- dedupe on `(source, external_id)`
- immutable raw snapshots
- normalized records written to `source_items`
- source metadata preserved, not flattened away

### Done when

- Gmail, Telegram channels, and Reddit all populate `source_items`
- raw files exist for each source
- repeated runs update existing rows rather than duplicating them

---

## Phase 4 - Port Harvest Scoring and Insight Extraction

**Goal:** keep the current ranking logic, not just the output labels.

### Harvest scoring

Port the current scoring logic into shared TypeScript code and run it during ingestion.

The migration must preserve these concepts:

- complaint language
- manual work signals
- workflow context
- existing spend signals
- source pattern boosts and penalties
- engagement boosts for Telegram and Reddit
- comment-thread bonus

Persist the current metadata shape:

- `harvest_score`
- `harvest_signals`
- `source_patterns`
- `harvest_breakdown`

### Insight extraction

Build `$extract-insights` that:

- loads unprocessed `source_items`
- sorts by harvest score and recency
- writes typed `insights`
- keeps the current insight types:
  - `pain_point`
  - `demand_signal`
  - `workflow_gap`
  - `distribution_clue`
  - `willingness_to_pay`
  - `competitor_move`
  - `implementation_constraint`

Prefer LLM extraction, but keep a heuristic fallback so the system still works when the model/tool path fails.

### Done when

- high-signal items outrank promotional noise
- new source items produce insights
- extraction can succeed even if the preferred LLM path is unavailable

---

## Phase 5 - Port Opportunity Clustering and Research

**Goal:** reproduce the current research pipeline, including review gating.

### Opportunity refresh

Build `$refresh-opportunities` that:

- clusters recent insights by keyword-derived cluster keys
- updates `opportunities`
- maintains `opportunity_sources`
- preserves score inputs:
  - evidence score
  - harvest score
  - source diversity
  - insight count

### Research drafting

Build `$research-opportunity` that:

- loads the opportunity and linked source items
- optionally performs web enrichment
- creates a `runs` row
- stores the draft in `runs.metadata_json`
- moves the run to `review_gate`

The draft should preserve the current sections:

- thesis
- evidence from inbox
- evidence from Telegram
- evidence from Reddit
- external market check
- product concept
- MVP scope
- implementation plan
- distribution plan
- risks
- decision for human review

### Done when

- a research request creates a run
- the run lands in `review_gate`
- the draft can be reviewed from Telegram

---

## Phase 6 - Approval Gate and Artifact Generation

**Goal:** keep the current human-review contract.

### Required behavior

1. Research output is reviewable before publication.
2. Approval writes a Markdown artifact.
3. Rejection records a decision and stops publication.

### Implementation

Build a Telegram-driven review flow that supports:

- list opportunities
- start research for an opportunity
- inspect run status
- approve a run
- reject a run
- fetch the generated artifact path or latest artifact summary

Natural-language commands are fine. Inline Telegram buttons are optional after the text flow works.

On approval:

- render Markdown to `groups/idea-maze/data/artifacts/YYYY/MM/DD/<slug>.md`
- create an `approvals` row
- create an `artifacts` row
- update run status to `approved`

On rejection:

- create an `approvals` row
- update run status to `rejected`

### Done when

- approved runs create Markdown artifacts
- rejected runs do not
- approval history is queryable

---

## Phase 7 - Scheduler and Operational Jobs

**Goal:** automate the pipeline using NanoClaw's task system.

Do **not** treat this as "edit `src/task-scheduler.ts` for every job."

NanoClaw already has scheduled task support. Use that task system to run Idea Maze workflows in the `idea-maze` workspace.

### Recommended jobs

| Job | Schedule | Action |
|---|---|---|
| Gmail ingestion | Every 30 minutes | Run `$ingest-gmail` |
| Telegram channel ingestion | Every 60 minutes | Run `$ingest-telegram-channels` |
| Reddit ingestion | Every 60 minutes | Run `$ingest-reddit` |
| Insight extraction | Every 2 hours | Run `$extract-insights` |
| Opportunity refresh | Daily at 06:00 | Run `$refresh-opportunities` |
| Weekly digest | Monday at 08:00 | Summarize top opportunities to Telegram |
| Raw cleanup | Daily | Delete raw files past retention window |

### Operational safeguards

- serialize Idea Maze runs per workspace, or keep an explicit run lock in `lab.db`
- scheduled jobs should report success/failure back to Telegram
- scheduled jobs must run in the Idea Maze group context so they see the right filesystem

### Done when

- tasks are visible in NanoClaw's task list
- tasks can be paused/resumed from Telegram
- overlapping runs do not corrupt state

---

## ~~Phase 8 - Data Migration and Cutover~~

**Skipped** — starting fresh, no data migration from the Python service.

---

## Phase 9 - VPS Deployment

**Goal:** run NanoClaw as the only production service.

### Steps

1. Provision a VPS.
2. Install Docker and Node.js 20+.
3. Clone the NanoClaw fork.
4. Copy credentials into `.env`.
5. Sync environment to NanoClaw's runtime location if the selected skill/setup path requires it.
6. Initialize the Idea Maze workspace and `groups/idea-maze/data/lab.db`.
7. Start NanoClaw.
8. Configure systemd or the platform's service manager for restart-on-failure.
9. Back up:
   - `store/messages.db`
   - `groups/idea-maze/data/lab.db`
   - `groups/idea-maze/data/artifacts/`
   - optionally `groups/idea-maze/data/raw/`

---

## Explicit Decisions

- Use NanoClaw for orchestration, not as a substitute for the Idea Maze domain schema.
- Use a dedicated Idea Maze workspace folder.
- Keep Gmail in tool-only mode.
- Keep Reddit unless it is consciously de-scoped.
- Keep the approval gate.
- Keep raw snapshots and artifact files.
- Keep deterministic harvest scoring in code.

---

## Acceptance Checklist

- Telegram control path works end to end
- dedicated Idea Maze workspace exists
- `lab.db` schema exists with FTS
- Gmail ingestion works
- Telegram channel ingestion works
- Reddit ingestion works
- raw files are written for every source
- harvest scores are persisted
- insights are created from unprocessed items
- opportunities are refreshed and linked to sources
- research runs enter `review_gate`
- approval writes Markdown artifacts
- rejection is recorded correctly
- scheduled jobs are visible and controllable from Telegram
- old Python service can be turned off without losing functionality

---

## Summary

The correct migration is **not** "put everything into NanoClaw's `messages` table and replace the pipeline with a few prompts."

The correct migration is:

- NanoClaw for Telegram, scheduling, agents, and isolation
- a dedicated Idea Maze workspace inside NanoClaw
- a ported Idea Maze SQLite schema and workflow
- custom ingestion/research skills backed by code
- a deliberate cutover after parity is proven
