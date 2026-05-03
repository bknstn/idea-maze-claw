import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

const IDEA_MAZE_GROUP_FOLDER = 'idea-maze';
const ARTIFACT_SOURCE_PREFIX = 'data/artifacts/';
const FAILED_RETRY_DELAY_MS = 15 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const STALE_RUNNING_MS = 10 * 60 * 1000;
const DEFAULT_GIT_AUTHOR_EMAIL = 'nanoclaw@example.com';
const DEFAULT_GIT_AUTHOR_NAME = 'NanoClaw';

interface MirrorConfig {
  repoBranch: string;
  repoDir: string;
  repoUrl: string;
}

interface ArtifactExportRow {
  artifact_id: number;
  artifact_path: string;
  attempt_count: number;
  commit_sha: string | null;
  created_at_utc: string;
  id: number;
  last_attempt_at_utc: string | null;
  last_error: string | null;
  opportunity_id: number;
  relative_path: string;
  repo_branch: string | null;
  repo_url: string | null;
  run_id: number;
  status: 'failed' | 'pending' | 'running' | 'succeeded';
  updated_at_utc: string;
}

interface BackfillArtifactRow {
  artifact_id: number;
  artifact_path: string;
  created_at_utc: string;
  opportunity_id: number;
  run_id: number;
}

let drainInFlight: Promise<number> | null = null;
let exporterStarted = false;
let reconcileTimer: NodeJS.Timeout | null = null;
let rerunRequested = false;

function summarizeExecError(err: unknown): string {
  if (err instanceof Error) {
    const stdout =
      typeof (err as any).stdout === 'string' ? (err as any).stdout.trim() : '';
    const stderr =
      typeof (err as any).stderr === 'string' ? (err as any).stderr.trim() : '';
    return stderr || stdout || err.message;
  }
  return String(err);
}

function runGitCommand(args: string[], cwd?: string): string {
  const gitArgs = cwd ? ['-C', cwd, ...args] : args;
  return execFileSync('git', gitArgs, {
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL:
        process.env.GIT_AUTHOR_EMAIL || DEFAULT_GIT_AUTHOR_EMAIL,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || DEFAULT_GIT_AUTHOR_NAME,
      GIT_COMMITTER_EMAIL:
        process.env.GIT_COMMITTER_EMAIL ||
        process.env.GIT_AUTHOR_EMAIL ||
        DEFAULT_GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME:
        process.env.GIT_COMMITTER_NAME ||
        process.env.GIT_AUTHOR_NAME ||
        DEFAULT_GIT_AUTHOR_NAME,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function hasVerifiedHead(cwd: string): boolean {
  try {
    runGitCommand(['rev-parse', '--verify', 'HEAD'], cwd);
    return true;
  } catch {
    return false;
  }
}

function loadMirrorConfig(): MirrorConfig | null {
  const envConfig = readEnvFile([
    'IDEA_MAZE_ARTIFACTS_REPO_BRANCH',
    'IDEA_MAZE_ARTIFACTS_REPO_DIR',
    'IDEA_MAZE_ARTIFACTS_REPO_URL',
  ]);
  const repoUrl =
    process.env.IDEA_MAZE_ARTIFACTS_REPO_URL ||
    envConfig.IDEA_MAZE_ARTIFACTS_REPO_URL;
  if (!repoUrl?.trim()) {
    return null;
  }

  const repoBranch =
    process.env.IDEA_MAZE_ARTIFACTS_REPO_BRANCH ||
    envConfig.IDEA_MAZE_ARTIFACTS_REPO_BRANCH ||
    'main';
  const repoDir =
    process.env.IDEA_MAZE_ARTIFACTS_REPO_DIR ||
    envConfig.IDEA_MAZE_ARTIFACTS_REPO_DIR ||
    path.resolve(DATA_DIR, 'idea-maze-artifacts-repo');

  return {
    repoBranch: repoBranch.trim(),
    repoDir: path.resolve(repoDir),
    repoUrl: repoUrl.trim(),
  };
}

function ensureArtifactExportsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_exports (
      id                  INTEGER PRIMARY KEY,
      artifact_id         INTEGER NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE CASCADE,
      status              TEXT    NOT NULL DEFAULT 'pending',
      relative_path       TEXT    NOT NULL,
      repo_url            TEXT,
      repo_branch         TEXT,
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      last_attempt_at_utc TEXT,
      commit_sha          TEXT,
      last_error          TEXT,
      created_at_utc      TEXT    NOT NULL,
      updated_at_utc      TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ix_artifact_exports_status
      ON artifact_exports(status);
    CREATE INDEX IF NOT EXISTS ix_artifact_exports_updated_at_utc
      ON artifact_exports(updated_at_utc);
    CREATE INDEX IF NOT EXISTS ix_artifact_exports_last_attempt_at_utc
      ON artifact_exports(last_attempt_at_utc);

    CREATE TABLE IF NOT EXISTS run_events (
      id              INTEGER PRIMARY KEY,
      run_id          INTEGER REFERENCES runs(id) ON DELETE CASCADE,
      opportunity_id  INTEGER REFERENCES opportunities(id) ON DELETE CASCADE,
      event_type      TEXT    NOT NULL,
      stage           TEXT,
      actor           TEXT    NOT NULL DEFAULT 'system',
      status          TEXT    NOT NULL DEFAULT 'info',
      summary         TEXT    NOT NULL,
      payload_json    TEXT    NOT NULL DEFAULT '{}',
      created_at_utc  TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ix_run_events_run_id
      ON run_events(run_id);
    CREATE INDEX IF NOT EXISTS ix_run_events_opportunity_id
      ON run_events(opportunity_id);
    CREATE INDEX IF NOT EXISTS ix_run_events_stage
      ON run_events(stage);
    CREATE INDEX IF NOT EXISTS ix_run_events_status
      ON run_events(status);
    CREATE INDEX IF NOT EXISTS ix_run_events_created_at_utc
      ON run_events(created_at_utc);
  `);
}

function openIdeaMazeDb(): Database.Database | null {
  const groupDir = resolveGroupFolderPath(IDEA_MAZE_GROUP_FOLDER);
  const dbPath = path.join(groupDir, 'data', 'lab.db');
  if (!fs.existsSync(dbPath)) {
    return null;
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  ensureArtifactExportsSchema(db);
  return db;
}

function recordRunEvent(
  db: Database.Database,
  input: {
    eventType: string;
    opportunityId: number;
    payload: unknown;
    runId: number;
    stage: string;
    status: 'error' | 'info' | 'ok' | 'warning';
    summary: string;
  },
): void {
  db.prepare(
    `
    INSERT INTO run_events (
      run_id,
      opportunity_id,
      event_type,
      stage,
      actor,
      status,
      summary,
      payload_json,
      created_at_utc
    )
    VALUES (?, ?, ?, ?, 'system', ?, ?, ?, ?)
  `,
  ).run(
    input.runId,
    input.opportunityId,
    input.eventType,
    input.stage,
    input.status,
    input.summary,
    JSON.stringify(input.payload ?? {}),
    new Date().toISOString(),
  );
}

function normalizeArtifactSourceRelativePath(rawPath: string): string {
  const normalized = rawPath.replaceAll('\\', '/');
  if (normalized.startsWith(ARTIFACT_SOURCE_PREFIX)) {
    return normalized;
  }

  const prefixedIndex = normalized.indexOf(`/${ARTIFACT_SOURCE_PREFIX}`);
  if (prefixedIndex !== -1) {
    return normalized.slice(prefixedIndex + 1);
  }

  const prefixlessMatch = normalized.match(/^\d{4}\/\d{2}\/\d{2}\/.+$/);
  if (prefixlessMatch) {
    return `${ARTIFACT_SOURCE_PREFIX}${normalized}`;
  }

  throw new Error(`Unrecognized artifact path '${rawPath}'`);
}

function toRepoRelativePath(relativePath: string): string {
  return normalizeArtifactSourceRelativePath(relativePath).slice(
    ARTIFACT_SOURCE_PREFIX.length,
  );
}

function resolveIdeaMazeArtifactSourcePath(relativePath: string): string {
  const groupDir = resolveGroupFolderPath(IDEA_MAZE_GROUP_FOLDER);
  return path.resolve(
    groupDir,
    ...normalizeArtifactSourceRelativePath(relativePath).split('/'),
  );
}

function ensureMirrorCheckout(config: MirrorConfig): void {
  if (!fs.existsSync(path.join(config.repoDir, '.git'))) {
    fs.mkdirSync(path.dirname(config.repoDir), { recursive: true });
    runGitCommand(
      [
        'clone',
        '--branch',
        config.repoBranch,
        '--single-branch',
        config.repoUrl,
        config.repoDir,
      ],
      undefined,
    );
  }

  const originUrl = runGitCommand(
    ['remote', 'get-url', 'origin'],
    config.repoDir,
  );
  if (originUrl !== config.repoUrl) {
    throw new Error(
      `Artifacts repo checkout at ${config.repoDir} points to ${originUrl}, expected ${config.repoUrl}.`,
    );
  }

  const currentBranch = runGitCommand(
    ['branch', '--show-current'],
    config.repoDir,
  );
  if (currentBranch && currentBranch !== config.repoBranch) {
    throw new Error(
      `Artifacts repo checkout at ${config.repoDir} is on branch ${currentBranch}, expected ${config.repoBranch}.`,
    );
  }

  runGitCommand(['fetch', 'origin', config.repoBranch], config.repoDir);
  if (!hasVerifiedHead(config.repoDir)) {
    runGitCommand(
      ['checkout', '-B', config.repoBranch, `origin/${config.repoBranch}`],
      config.repoDir,
    );
  }
  const [behindStr, aheadStr] = runGitCommand(
    [
      'rev-list',
      '--left-right',
      '--count',
      `origin/${config.repoBranch}...HEAD`,
    ],
    config.repoDir,
  ).split(/\s+/);
  const behind = Number(behindStr || '0');
  const ahead = Number(aheadStr || '0');

  if (behind > 0 && ahead > 0) {
    throw new Error(
      `Artifacts repo checkout at ${config.repoDir} has diverged from origin/${config.repoBranch}.`,
    );
  }
  if (behind > 0) {
    runGitCommand(
      ['pull', '--ff-only', 'origin', config.repoBranch],
      config.repoDir,
    );
  }
  if (ahead > 0) {
    runGitCommand(['push', 'origin', config.repoBranch], config.repoDir);
  }

  const status = runGitCommand(['status', '--porcelain'], config.repoDir);
  if (status) {
    throw new Error(
      `Artifacts repo checkout at ${config.repoDir} has uncommitted changes and must be cleaned before export.`,
    );
  }
}

function claimEligibleRows(
  db: Database.Database,
  config: MirrorConfig,
  now: Date,
): ArtifactExportRow[] {
  const nowIso = now.toISOString();
  const failedCutoffIso = new Date(
    now.getTime() - FAILED_RETRY_DELAY_MS,
  ).toISOString();
  const staleRunningCutoffIso = new Date(
    now.getTime() - STALE_RUNNING_MS,
  ).toISOString();

  db.prepare(
    `
    UPDATE artifact_exports
    SET status = 'pending',
        updated_at_utc = ?
    WHERE status = 'running'
      AND last_attempt_at_utc IS NOT NULL
      AND last_attempt_at_utc <= ?
  `,
  ).run(nowIso, staleRunningCutoffIso);

  const rows = db
    .prepare(
      `
    SELECT
      ae.*,
      a.path AS artifact_path,
      a.run_id,
      a.opportunity_id
    FROM artifact_exports ae
    JOIN artifacts a ON a.id = ae.artifact_id
    WHERE ae.status = 'pending'
       OR (
         ae.status = 'failed'
         AND (
           ae.last_attempt_at_utc IS NULL
           OR ae.last_attempt_at_utc <= ?
         )
       )
    ORDER BY ae.created_at_utc ASC, ae.id ASC
  `,
    )
    .all(failedCutoffIso) as ArtifactExportRow[];

  if (rows.length === 0) {
    return [];
  }

  const markRunning = db.prepare(`
    UPDATE artifact_exports
    SET status = 'running',
        repo_url = ?,
        repo_branch = ?,
        attempt_count = attempt_count + 1,
        last_attempt_at_utc = ?,
        last_error = NULL,
        updated_at_utc = ?
    WHERE artifact_id = ?
  `);
  const tx = db.transaction((items: ArtifactExportRow[]) => {
    for (const row of items) {
      markRunning.run(
        config.repoUrl,
        config.repoBranch,
        nowIso,
        nowIso,
        row.artifact_id,
      );
    }
  });
  tx(rows);
  return rows.map((row) => ({
    ...row,
    attempt_count: row.attempt_count + 1,
    last_attempt_at_utc: nowIso,
    last_error: null,
    repo_branch: config.repoBranch,
    repo_url: config.repoUrl,
    status: 'running',
    updated_at_utc: nowIso,
  }));
}

function markRowsSucceeded(
  db: Database.Database,
  rows: ArtifactExportRow[],
  config: MirrorConfig,
  commitSha: string | null,
  now: Date,
): void {
  const nowIso = now.toISOString();
  const updateRow = db.prepare(`
    UPDATE artifact_exports
    SET status = 'succeeded',
        repo_url = ?,
        repo_branch = ?,
        commit_sha = ?,
        last_error = NULL,
        updated_at_utc = ?
    WHERE artifact_id = ?
  `);
  const tx = db.transaction((items: ArtifactExportRow[]) => {
    for (const row of items) {
      updateRow.run(
        config.repoUrl,
        config.repoBranch,
        commitSha,
        nowIso,
        row.artifact_id,
      );
      recordRunEvent(db, {
        eventType: 'artifact_export.succeeded',
        opportunityId: row.opportunity_id,
        payload: {
          artifact_id: row.artifact_id,
          artifact_path: row.artifact_path,
          commit_sha: commitSha,
          relative_path: row.relative_path,
          repo_branch: config.repoBranch,
          repo_relative_path: toRepoRelativePath(row.relative_path),
          repo_url: config.repoUrl,
        },
        runId: row.run_id,
        stage: 'artifact',
        status: 'ok',
        summary: 'Artifact export completed.',
      });
    }
  });
  tx(rows);
}

function markRowFailed(
  db: Database.Database,
  row: ArtifactExportRow,
  config: MirrorConfig | null,
  failure: string,
  now: Date,
): void {
  const nowIso = now.toISOString();
  db.prepare(
    `
    UPDATE artifact_exports
    SET status = 'failed',
        repo_url = COALESCE(?, repo_url),
        repo_branch = COALESCE(?, repo_branch),
        last_error = ?,
        updated_at_utc = ?
    WHERE artifact_id = ?
  `,
  ).run(
    config?.repoUrl ?? null,
    config?.repoBranch ?? null,
    failure,
    nowIso,
    row.artifact_id,
  );
  recordRunEvent(db, {
    eventType: 'artifact_export.failed',
    opportunityId: row.opportunity_id,
    payload: {
      artifact_id: row.artifact_id,
      artifact_path: row.artifact_path,
      failure,
      relative_path: row.relative_path,
      repo_branch: config?.repoBranch ?? row.repo_branch,
      repo_url: config?.repoUrl ?? row.repo_url,
    },
    runId: row.run_id,
    stage: 'artifact',
    status: 'error',
    summary: 'Artifact export failed.',
  });
}

function recordStartedEvents(
  db: Database.Database,
  rows: ArtifactExportRow[],
  config: MirrorConfig,
): void {
  const tx = db.transaction((items: ArtifactExportRow[]) => {
    for (const row of items) {
      recordRunEvent(db, {
        eventType: 'artifact_export.started',
        opportunityId: row.opportunity_id,
        payload: {
          artifact_id: row.artifact_id,
          artifact_path: row.artifact_path,
          relative_path: row.relative_path,
          repo_branch: config.repoBranch,
          repo_url: config.repoUrl,
        },
        runId: row.run_id,
        stage: 'artifact',
        status: 'info',
        summary: 'Artifact export started.',
      });
    }
  });
  tx(rows);
}

function exportRowsToMirror(
  db: Database.Database,
  rows: ArtifactExportRow[],
  config: MirrorConfig,
  now: Date,
): void {
  if (rows.length === 0) {
    return;
  }

  const readyRows: ArtifactExportRow[] = [];
  for (const row of rows) {
    try {
      const sourcePath = resolveIdeaMazeArtifactSourcePath(row.relative_path);
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Artifact source file not found: ${sourcePath}`);
      }
      readyRows.push(row);
    } catch (err) {
      markRowFailed(db, row, config, summarizeExecError(err), now);
    }
  }

  if (readyRows.length === 0) {
    return;
  }

  recordStartedEvents(db, readyRows, config);

  try {
    ensureMirrorCheckout(config);

    const repoPaths: string[] = [];
    for (const row of readyRows) {
      const sourcePath = resolveIdeaMazeArtifactSourcePath(row.relative_path);
      const repoRelativePath = toRepoRelativePath(row.relative_path);
      const destinationPath = path.resolve(config.repoDir, repoRelativePath);
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
      repoPaths.push(repoRelativePath);
    }

    runGitCommand(['add', '--', ...repoPaths], config.repoDir);
    const status = runGitCommand(
      ['status', '--short', '--', ...repoPaths],
      config.repoDir,
    );

    let commitSha: string | null = null;
    if (status) {
      const commitMessage =
        readyRows.length === 1
          ? `Export Idea Maze artifact ${path.basename(readyRows[0].relative_path, '.md')}`
          : `Export ${readyRows.length} Idea Maze artifacts`;
      runGitCommand(['commit', '-m', commitMessage], config.repoDir);
      commitSha = runGitCommand(['rev-parse', 'HEAD'], config.repoDir);
      runGitCommand(['push', 'origin', config.repoBranch], config.repoDir);
    }

    markRowsSucceeded(db, readyRows, config, commitSha, now);
  } catch (err) {
    const failure = summarizeExecError(err);
    for (const row of readyRows) {
      markRowFailed(db, row, config, failure, now);
    }
  }
}

function nextUtcDate(date: string): string {
  const nextDay = new Date(`${date}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return nextDay.toISOString().slice(0, 10);
}

export function queueIdeaMazeArtifactExportBackfill(
  options: {
    date?: string;
    now?: Date;
  } = {},
): number {
  const config = loadMirrorConfig();
  if (!config) {
    return 0;
  }

  const db = openIdeaMazeDb();
  if (!db) {
    return 0;
  }

  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const date = options.date;
  const startIso = date ? `${date}T00:00:00.000Z` : null;
  const endIso = date ? `${nextUtcDate(date)}T00:00:00.000Z` : null;

  try {
    const rows = db
      .prepare(
        `
      SELECT
        a.id AS artifact_id,
        a.path AS artifact_path,
        COALESCE(a.approved_at_utc, a.created_at_utc) AS created_at_utc,
        a.run_id,
        a.opportunity_id
      FROM artifacts a
      LEFT JOIN artifact_exports ae ON ae.artifact_id = a.id
      WHERE ae.id IS NULL
        AND (? IS NULL OR COALESCE(a.approved_at_utc, a.created_at_utc) >= ?)
        AND (? IS NULL OR COALESCE(a.approved_at_utc, a.created_at_utc) < ?)
      ORDER BY COALESCE(a.approved_at_utc, a.created_at_utc) ASC, a.id ASC
    `,
      )
      .all(startIso, startIso, endIso, endIso) as BackfillArtifactRow[];

    const insertExport = db.prepare(`
      INSERT INTO artifact_exports (
        artifact_id,
        status,
        relative_path,
        repo_url,
        repo_branch,
        attempt_count,
        last_attempt_at_utc,
        commit_sha,
        last_error,
        created_at_utc,
        updated_at_utc
      )
      VALUES (?, 'pending', ?, ?, ?, 0, NULL, NULL, NULL, ?, ?)
    `);

    let queued = 0;
    const tx = db.transaction((items: BackfillArtifactRow[]) => {
      for (const row of items) {
        try {
          const relativePath = normalizeArtifactSourceRelativePath(
            row.artifact_path,
          );
          insertExport.run(
            row.artifact_id,
            relativePath,
            config.repoUrl,
            config.repoBranch,
            nowIso,
            nowIso,
          );
          recordRunEvent(db, {
            eventType: 'artifact_export.queued',
            opportunityId: row.opportunity_id,
            payload: {
              artifact_id: row.artifact_id,
              backfill_date: date ?? 'all',
              ipc_wakeup_sent: false,
              relative_path: relativePath,
              repo_branch: config.repoBranch,
              repo_url: config.repoUrl,
            },
            runId: row.run_id,
            stage: 'artifact',
            status: 'info',
            summary: 'Artifact export queued for host processing.',
          });
          queued++;
        } catch (err) {
          logger.warn(
            {
              artifactId: row.artifact_id,
              err,
              rawPath: row.artifact_path,
            },
            'Skipping artifact export backfill row with invalid path',
          );
        }
      }
    });
    tx(rows);
    return queued;
  } finally {
    db.close();
  }
}

export async function drainIdeaMazeArtifactExports(
  options: {
    now?: Date;
    source?: 'ipc' | 'reconcile' | 'startup';
  } = {},
): Promise<number> {
  const config = loadMirrorConfig();
  if (!config) {
    return 0;
  }

  const db = openIdeaMazeDb();
  if (!db) {
    return 0;
  }

  const now = options.now ?? new Date();
  try {
    const rows = claimEligibleRows(db, config, now);
    exportRowsToMirror(db, rows, config, now);
    return rows.length;
  } finally {
    db.close();
  }
}

export function requestIdeaMazeArtifactExportDrain(
  source: 'ipc' | 'reconcile' | 'startup',
  groupFolder: string = IDEA_MAZE_GROUP_FOLDER,
): void {
  if (groupFolder !== IDEA_MAZE_GROUP_FOLDER) {
    return;
  }

  if (drainInFlight) {
    rerunRequested = true;
    return;
  }

  drainInFlight = drainIdeaMazeArtifactExports({ source })
    .catch((err) => {
      logger.error({ err, source }, 'Idea Maze artifact export drain failed');
      return 0;
    })
    .finally(() => {
      drainInFlight = null;
      if (rerunRequested) {
        rerunRequested = false;
        requestIdeaMazeArtifactExportDrain(source, groupFolder);
      }
    });
}

export function startIdeaMazeArtifactExporter(): void {
  if (exporterStarted) {
    return;
  }
  exporterStarted = true;

  const queued = queueIdeaMazeArtifactExportBackfill();
  if (queued > 0) {
    logger.info({ queued }, 'Queued Idea Maze artifact export backfill rows');
  }

  requestIdeaMazeArtifactExportDrain('startup');
  reconcileTimer = setInterval(() => {
    requestIdeaMazeArtifactExportDrain('reconcile');
  }, RECONCILE_INTERVAL_MS);
}

export function resetIdeaMazeArtifactExporterForTests(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  drainInFlight = null;
  exporterStarted = false;
  rerunRequested = false;
}
