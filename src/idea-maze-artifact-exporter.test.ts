import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockedPaths = vi.hoisted(() => ({
  dataDir: '',
  groupsDir: '',
}));

const readEnvFileMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return mockedPaths.dataDir;
  },
  get GROUPS_DIR() {
    return mockedPaths.groupsDir;
  },
}));

vi.mock('./env.js', () => ({
  readEnvFile: readEnvFileMock,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

function git(args: string[], cwd?: string): string {
  const gitArgs = cwd ? ['-C', cwd, ...args] : args;
  return execFileSync('git', gitArgs, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initIdeaMazeDb(groupDir: string): Database.Database {
  const dbPath = path.join(groupDir, 'data', 'lab.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE opportunities (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      thesis TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      market_score REAL NOT NULL DEFAULT 0,
      final_score REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      lifecycle_stage TEXT NOT NULL DEFAULT 'scored',
      cluster_key TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL,
      last_reviewed_at_utc TEXT
    );

    CREATE TABLE runs (
      id INTEGER PRIMARY KEY,
      run_type TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      requested_by TEXT NOT NULL DEFAULT 'system',
      started_at_utc TEXT NOT NULL,
      completed_at_utc TEXT,
      error TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE artifacts (
      id INTEGER PRIMARY KEY,
      opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      approved_at_utc TEXT,
      created_at_utc TEXT NOT NULL
    );

    CREATE TABLE artifact_exports (
      id INTEGER PRIMARY KEY,
      artifact_id INTEGER NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      relative_path TEXT NOT NULL,
      repo_url TEXT,
      repo_branch TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at_utc TEXT,
      commit_sha TEXT,
      last_error TEXT,
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE run_events (
      id INTEGER PRIMARY KEY,
      run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE,
      opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      stage TEXT,
      actor TEXT NOT NULL DEFAULT 'system',
      status TEXT NOT NULL DEFAULT 'info',
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at_utc TEXT NOT NULL
    );
  `);
  return db;
}

function seedGitRemote(remoteDir: string, seedDir: string): void {
  git(['init', '--bare', remoteDir]);
  fs.mkdirSync(seedDir, { recursive: true });
  git(['init'], seedDir);
  git(['checkout', '-b', 'main'], seedDir);
  fs.writeFileSync(path.join(seedDir, 'README.md'), '# Mirror\n', 'utf-8');
  git(['add', '--', 'README.md'], seedDir);
  git(['commit', '-m', 'Initial commit'], seedDir);
  git(['remote', 'add', 'origin', remoteDir], seedDir);
  git(['push', '-u', 'origin', 'main'], seedDir);
}

describe('Idea Maze artifact exporter', () => {
  let artifactExporter:
    | typeof import('./idea-maze-artifact-exporter.js')
    | null = null;
  let rootDir: string;
  let groupDir: string;
  let mirrorCheckoutDir: string;
  let remoteRepoDir: string;

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-maze-exporter-'));
    mockedPaths.dataDir = path.join(rootDir, 'data');
    mockedPaths.groupsDir = path.join(rootDir, 'groups');
    groupDir = path.join(mockedPaths.groupsDir, 'idea-maze');
    remoteRepoDir = path.join(rootDir, 'mirror.git');
    mirrorCheckoutDir = path.join(rootDir, 'mirror-checkout');

    fs.mkdirSync(path.join(groupDir, 'data'), { recursive: true });
    fs.mkdirSync(mockedPaths.dataDir, { recursive: true });
    seedGitRemote(remoteRepoDir, path.join(rootDir, 'mirror-seed'));

    process.env.GIT_AUTHOR_NAME = 'NanoClaw Test';
    process.env.GIT_AUTHOR_EMAIL = 'nanoclaw@example.com';
    process.env.GIT_COMMITTER_NAME = 'NanoClaw Test';
    process.env.GIT_COMMITTER_EMAIL = 'nanoclaw@example.com';
    process.env.IDEA_MAZE_ARTIFACTS_REPO_BRANCH = 'main';
    process.env.IDEA_MAZE_ARTIFACTS_REPO_DIR = mirrorCheckoutDir;
    process.env.IDEA_MAZE_ARTIFACTS_REPO_URL = remoteRepoDir;
    vi.resetModules();
    artifactExporter = await import('./idea-maze-artifact-exporter.js');
  });

  afterEach(() => {
    artifactExporter?.resetIdeaMazeArtifactExporterForTests();
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;
    delete process.env.IDEA_MAZE_ARTIFACTS_REPO_BRANCH;
    delete process.env.IDEA_MAZE_ARTIFACTS_REPO_DIR;
    delete process.env.IDEA_MAZE_ARTIFACTS_REPO_URL;
    fs.rmSync(rootDir, { force: true, recursive: true });
  });

  it('exports pending rows to the mirror repo and does not duplicate commits on a second drain', async () => {
    const db = initIdeaMazeDb(groupDir);
    const dbPath = path.join(groupDir, 'data', 'lab.db');
    const artifactRelativePath = 'data/artifacts/2026/04/19/finance-ops.md';
    const artifactAbsolutePath = path.join(
      groupDir,
      ...artifactRelativePath.split('/'),
    );

    fs.mkdirSync(path.dirname(artifactAbsolutePath), { recursive: true });
    fs.writeFileSync(artifactAbsolutePath, 'finance ops\n', 'utf-8');

    db.prepare(
      `
      INSERT INTO opportunities (
        id, slug, title, thesis, score, market_score, final_score, status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc
      )
      VALUES (1, 'finance-ops', 'Finance Ops', 'Invoice pain', 8, 8, 8, 'active', 'approved', 'finance-ops', '{}', '2026-04-19T07:00:00.000Z', '2026-04-19T07:00:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO runs (id, run_type, target_type, target_id, status, requested_by, started_at_utc, completed_at_utc, metadata_json)
      VALUES (1, 'research', 'opportunity', '1', 'approved', 'system', '2026-04-19T07:00:00.000Z', '2026-04-19T07:02:00.000Z', '{}')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO artifacts (id, opportunity_id, run_id, path, version, approved_at_utc, created_at_utc)
      VALUES (1, 1, 1, ?, 1, '2026-04-19T07:02:00.000Z', '2026-04-19T07:02:00.000Z')
    `,
    ).run(artifactAbsolutePath);
    db.prepare(
      `
      INSERT INTO artifact_exports (
        artifact_id, status, relative_path, repo_url, repo_branch, attempt_count, last_attempt_at_utc, commit_sha, last_error, created_at_utc, updated_at_utc
      )
      VALUES (1, 'pending', ?, ?, 'main', 0, NULL, NULL, NULL, '2026-04-19T07:02:00.000Z', '2026-04-19T07:02:00.000Z')
    `,
    ).run(artifactRelativePath, remoteRepoDir);
    db.close();

    await artifactExporter!.drainIdeaMazeArtifactExports({
      now: new Date('2026-04-19T08:00:00.000Z'),
      source: 'startup',
    });
    await artifactExporter!.drainIdeaMazeArtifactExports({
      now: new Date('2026-04-19T08:01:00.000Z'),
      source: 'ipc',
    });

    const inspectDb = new Database(dbPath);
    const exportRow = inspectDb
      .prepare(
        `
      SELECT status, attempt_count, commit_sha, last_error
      FROM artifact_exports
      WHERE artifact_id = 1
    `,
      )
      .get() as {
      attempt_count: number;
      commit_sha: string | null;
      last_error: string | null;
      status: string;
    };
    const events = inspectDb
      .prepare(
        `
      SELECT event_type
      FROM run_events
      WHERE run_id = 1
        AND event_type LIKE 'artifact_export.%'
      ORDER BY id ASC
    `,
      )
      .all() as Array<{ event_type: string }>;

    const inspectDir = path.join(rootDir, 'inspect');
    git(['clone', remoteRepoDir, inspectDir]);
    const mirroredBody = fs.readFileSync(
      path.join(inspectDir, '2026', '04', '19', 'finance-ops.md'),
      'utf-8',
    );
    const commitCount = Number(
      git(['rev-list', '--count', 'main'], inspectDir),
    );

    expect(exportRow.status).toBe('succeeded');
    expect(exportRow.attempt_count).toBe(1);
    expect(exportRow.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(exportRow.last_error).toBeNull();
    expect(events.map((event) => event.event_type)).toEqual([
      'artifact_export.started',
      'artifact_export.succeeded',
    ]);
    expect(mirroredBody).toBe('finance ops\n');
    expect(commitCount).toBe(2);

    inspectDb.close();
  });

  it('marks missing artifact files as failed and retries them successfully after the retry delay', async () => {
    const db = initIdeaMazeDb(groupDir);
    const dbPath = path.join(groupDir, 'data', 'lab.db');
    const artifactRelativePath = 'data/artifacts/2026/04/19/code-span.md';
    const artifactAbsolutePath = path.join(
      groupDir,
      ...artifactRelativePath.split('/'),
    );

    db.prepare(
      `
      INSERT INTO opportunities (
        id, slug, title, thesis, score, market_score, final_score, status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc
      )
      VALUES (1, 'code-span', 'Code Span', 'Debugging is painful', 8, 8, 8, 'active', 'approved', 'code-span', '{}', '2026-04-19T07:00:00.000Z', '2026-04-19T07:00:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO runs (id, run_type, target_type, target_id, status, requested_by, started_at_utc, completed_at_utc, metadata_json)
      VALUES (1, 'research', 'opportunity', '1', 'approved', 'system', '2026-04-19T07:00:00.000Z', '2026-04-19T07:02:00.000Z', '{}')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO artifacts (id, opportunity_id, run_id, path, version, approved_at_utc, created_at_utc)
      VALUES (1, 1, 1, ?, 1, '2026-04-19T07:02:00.000Z', '2026-04-19T07:02:00.000Z')
    `,
    ).run(artifactAbsolutePath);
    db.prepare(
      `
      INSERT INTO artifact_exports (
        artifact_id, status, relative_path, repo_url, repo_branch, attempt_count, last_attempt_at_utc, commit_sha, last_error, created_at_utc, updated_at_utc
      )
      VALUES (1, 'pending', ?, ?, 'main', 0, NULL, NULL, NULL, '2026-04-19T07:02:00.000Z', '2026-04-19T07:02:00.000Z')
    `,
    ).run(artifactRelativePath, remoteRepoDir);
    db.close();

    await artifactExporter!.drainIdeaMazeArtifactExports({
      now: new Date('2026-04-19T08:00:00.000Z'),
      source: 'startup',
    });

    let inspectDb = new Database(dbPath);
    let exportRow = inspectDb
      .prepare(
        `
      SELECT status, attempt_count, last_error
      FROM artifact_exports
      WHERE artifact_id = 1
    `,
      )
      .get() as {
      attempt_count: number;
      last_error: string | null;
      status: string;
    };

    expect(exportRow.status).toBe('failed');
    expect(exportRow.attempt_count).toBe(1);
    expect(exportRow.last_error).toContain('Artifact source file not found');
    inspectDb.close();

    fs.mkdirSync(path.dirname(artifactAbsolutePath), { recursive: true });
    fs.writeFileSync(artifactAbsolutePath, 'code span\n', 'utf-8');

    await artifactExporter!.drainIdeaMazeArtifactExports({
      now: new Date('2026-04-19T08:10:00.000Z'),
      source: 'reconcile',
    });

    inspectDb = new Database(dbPath);
    exportRow = inspectDb
      .prepare(
        `
      SELECT status, attempt_count, last_error
      FROM artifact_exports
      WHERE artifact_id = 1
    `,
      )
      .get() as {
      attempt_count: number;
      last_error: string | null;
      status: string;
    };
    expect(exportRow.status).toBe('failed');
    expect(exportRow.attempt_count).toBe(1);
    inspectDb.close();

    await artifactExporter!.drainIdeaMazeArtifactExports({
      now: new Date('2026-04-19T08:16:00.000Z'),
      source: 'reconcile',
    });

    inspectDb = new Database(dbPath);
    exportRow = inspectDb
      .prepare(
        `
      SELECT status, attempt_count, last_error
      FROM artifact_exports
      WHERE artifact_id = 1
    `,
      )
      .get() as {
      attempt_count: number;
      last_error: string | null;
      status: string;
    };

    expect(exportRow.status).toBe('succeeded');
    expect(exportRow.attempt_count).toBe(2);
    expect(exportRow.last_error).toBeNull();

    inspectDb.close();
  });

  it('queues only missing April 19 backfill rows and skips already-exported artifacts', async () => {
    const db = initIdeaMazeDb(groupDir);
    const dbPath = path.join(groupDir, 'data', 'lab.db');
    const oldArtifactPath = path.join(
      groupDir,
      'data',
      'artifacts',
      '2026',
      '04',
      '18',
      'old.md',
    );
    const existingArtifactPath = path.join(
      groupDir,
      'data',
      'artifacts',
      '2026',
      '04',
      '19',
      'existing.md',
    );
    const missingArtifactPath = path.join(
      groupDir,
      'data',
      'artifacts',
      '2026',
      '04',
      '19',
      'missing.md',
    );

    for (const filePath of [
      oldArtifactPath,
      existingArtifactPath,
      missingArtifactPath,
    ]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${path.basename(filePath)}\n`, 'utf-8');
    }

    db.prepare(
      `
      INSERT INTO opportunities (
        id, slug, title, thesis, score, market_score, final_score, status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc
      )
      VALUES
        (1, 'old', 'Old', 'old', 8, 8, 8, 'active', 'approved', 'old', '{}', '2026-04-18T07:00:00.000Z', '2026-04-18T07:00:00.000Z'),
        (2, 'existing', 'Existing', 'existing', 8, 8, 8, 'active', 'approved', 'existing', '{}', '2026-04-19T07:00:00.000Z', '2026-04-19T07:00:00.000Z'),
        (3, 'missing', 'Missing', 'missing', 8, 8, 8, 'active', 'approved', 'missing', '{}', '2026-04-19T07:00:00.000Z', '2026-04-19T07:00:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO runs (id, run_type, target_type, target_id, status, requested_by, started_at_utc, completed_at_utc, metadata_json)
      VALUES
        (1, 'research', 'opportunity', '1', 'approved', 'system', '2026-04-18T07:00:00.000Z', '2026-04-18T07:01:00.000Z', '{}'),
        (2, 'research', 'opportunity', '2', 'approved', 'system', '2026-04-19T07:00:00.000Z', '2026-04-19T07:01:00.000Z', '{}'),
        (3, 'research', 'opportunity', '3', 'approved', 'system', '2026-04-19T07:00:00.000Z', '2026-04-19T07:01:00.000Z', '{}')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO artifacts (id, opportunity_id, run_id, path, version, approved_at_utc, created_at_utc)
      VALUES
        (1, 1, 1, ?, 1, '2026-04-18T07:01:00.000Z', '2026-04-18T07:01:00.000Z'),
        (2, 2, 2, ?, 1, '2026-04-19T07:01:00.000Z', '2026-04-19T07:01:00.000Z'),
        (3, 3, 3, ?, 1, '2026-04-19T07:01:00.000Z', '2026-04-19T07:01:00.000Z')
    `,
    ).run(oldArtifactPath, existingArtifactPath, missingArtifactPath);
    db.prepare(
      `
      INSERT INTO artifact_exports (
        artifact_id, status, relative_path, repo_url, repo_branch, attempt_count, last_attempt_at_utc, commit_sha, last_error, created_at_utc, updated_at_utc
      )
      VALUES (2, 'succeeded', 'data/artifacts/2026/04/19/existing.md', ?, 'main', 1, '2026-04-19T07:05:00.000Z', 'abc123', NULL, '2026-04-19T07:02:00.000Z', '2026-04-19T07:05:00.000Z')
    `,
    ).run(remoteRepoDir);
    db.close();

    const queued = artifactExporter!.queueIdeaMazeArtifactExportBackfill({
      date: '2026-04-19',
      now: new Date('2026-04-19T08:00:00.000Z'),
    });

    const inspectDb = new Database(dbPath);
    const exportRows = inspectDb
      .prepare(
        `
      SELECT artifact_id, status, relative_path
      FROM artifact_exports
      ORDER BY artifact_id ASC
    `,
      )
      .all() as Array<{
      artifact_id: number;
      relative_path: string;
      status: string;
    }>;

    expect(queued).toBe(1);
    expect(exportRows).toEqual([
      {
        artifact_id: 2,
        relative_path: 'data/artifacts/2026/04/19/existing.md',
        status: 'succeeded',
      },
      {
        artifact_id: 3,
        relative_path: 'data/artifacts/2026/04/19/missing.md',
        status: 'pending',
      },
    ]);

    inspectDb.close();
  });
});
