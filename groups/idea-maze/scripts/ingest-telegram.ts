/**
 * Telegram channel ingestion — reads followed channel posts via GramJS user session.
 *
 * Prerequisites:
 *   1. Run auth-telegram.ts once to create a session (stored in app_state)
 *   2. Set TELEGRAM_API_ID and TELEGRAM_API_HASH in environment
 *   3. Configure channels: tsx -e "import {setAppState} from './lib/queries.ts'; setAppState('telegram_channels', ['channel_username'])"
 *
 * Usage: TELEGRAM_API_ID=... TELEGRAM_API_HASH=... tsx ingest-telegram.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl/index.js";
import { getDb, closeDb } from "./lib/db.ts";
import { initSchema } from "./lib/schema.ts";
import { scoreSourceItem } from "./lib/scoring.ts";
import { upsertSourceItem, getAppState, setAppState } from "./lib/queries.ts";

const GROUP_DIR = process.env.WORKSPACE_GROUP ?? "/workspace/group";
const DEFAULT_HOURS = 24;
const DEFAULT_MAX_POSTS = 100;

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function rawPath(channel: string, postId: number, timestamp: Date): string {
  const safe = channel.replace(/[^a-zA-Z0-9_-]/g, "_");
  const y = timestamp.getUTCFullYear();
  const m = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  const d = String(timestamp.getUTCDate()).padStart(2, "0");
  return resolve(GROUP_DIR, "data", "raw", "telegram", String(y), m, d, `${safe}_${postId}.json`);
}

async function ingestChannel(
  client: TelegramClient,
  channel: string,
  cutoffDate: Date,
  maxPosts: number,
): Promise<{ totalNew: number; totalUpdated: number; fetched: number }> {
  let totalNew = 0;
  let totalUpdated = 0;
  let fetched = 0;

  const messages = await client.getMessages(channel, {
    limit: maxPosts,
  });

  for (const msg of messages) {
    if (!(msg instanceof Api.Message)) continue;

    const text = normalizeWhitespace(msg.message ?? "");
    if (!text) continue;

    const timestamp = new Date(msg.date * 1000);
    if (timestamp < cutoffDate) continue;

    const postId = msg.id;
    const record = {
      channel,
      post_id: postId,
      date: timestamp.toISOString(),
      text,
      views: (msg as any).views ?? null,
      forwards: (msg as any).forwards ?? null,
      replies: (msg as any).replies?.replies ?? null,
    };

    const rp = rawPath(channel, postId, timestamp);
    writeJson(rp, record);

    const scoring = scoreSourceItem({
      source: "telegram",
      author: channel,
      title: null,
      text,
      metadata: { views: record.views, forwards: record.forwards, replies: record.replies },
    });

    const enrichedMeta = {
      channel,
      post_id: postId,
      views: record.views,
      forwards: record.forwards,
      replies: record.replies,
      harvest_score: scoring.score,
      harvest_signals: scoring.signals,
      source_patterns: scoring.patterns,
      harvest_breakdown: scoring.breakdown,
    };

    const { isNew } = upsertSourceItem({
      source: "telegram",
      external_id: `${channel}_${postId}`,
      thread_ref: `${channel}_${postId}`,
      author: channel,
      title: null,
      text,
      channel_or_label: channel,
      timestamp_utc: timestamp.toISOString(),
      raw_path: rp,
      content_hash: hashText(text),
      metadata_json: enrichedMeta,
    });

    fetched++;
    if (isNew) totalNew++;
    else totalUpdated++;
  }

  return { totalNew, totalUpdated, fetched };
}

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";

  if (!apiId || !apiHash) {
    console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH before running.");
    console.error("Get them from https://my.telegram.org → API development tools.");
    process.exit(1);
  }

  const db = getDb();
  initSchema(db);

  const session: string | null = getAppState("telegram_session");
  if (!session) {
    console.error("No session found. Run auth-telegram.ts first.");
    process.exit(1);
  }

  const channels: string[] = getAppState("telegram_channels") ?? [];
  if (!channels.length) {
    console.error("No channels configured. Set app_state key 'telegram_channels' first.");
    console.error("  tsx -e \"import {setAppState} from './lib/queries.ts'; setAppState('telegram_channels', ['channel_username'])\"");
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.connect();

  const cutoffDate = new Date(Date.now() - DEFAULT_HOURS * 3600 * 1000);
  let totalNew = 0;
  let totalUpdated = 0;

  for (const channel of channels) {
    process.stdout.write(`Fetching @${channel}...`);
    try {
      const result = await ingestChannel(client, channel, cutoffDate, DEFAULT_MAX_POSTS);
      console.log(` ${result.fetched} posts (new: ${result.totalNew}, updated: ${result.totalUpdated})`);
      totalNew += result.totalNew;
      totalUpdated += result.totalUpdated;
    } catch (err: any) {
      console.log(` ERROR: ${err.message}`);
    }
  }

  setAppState("telegram_last_harvest", new Date().toISOString());

  await client.disconnect();
  console.log(`\nDone. New: ${totalNew}, Updated: ${totalUpdated}`);
  closeDb();
}

main().catch((err) => {
  console.error("Telegram ingestion failed:", err);
  process.exit(1);
});
