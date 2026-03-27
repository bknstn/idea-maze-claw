/**
 * Gmail ingestion — batch harvests email via the Gmail API.
 *
 * Uses Gmail REST API directly (no Google client library).
 * Authentication is handled by OneCLI proxy or environment variables.
 *
 * Inside NanoClaw containers, the OneCLI proxy intercepts Gmail API calls
 * and injects OAuth tokens automatically. For local testing, set
 * GMAIL_ACCESS_TOKEN in the environment.
 *
 * Usage: tsx ingest-gmail.ts
 *
 * Configure:
 *   tsx -e "import {setAppState} from './lib/queries.ts'; setAppState('gmail_query', 'newer_than:1d -category:promotions')"
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { getDb, closeDb } from "./lib/db.ts";
import { initSchema } from "./lib/schema.ts";
import { scoreSourceItem } from "./lib/scoring.ts";
import { upsertSourceItem, getAppState, setAppState } from "./lib/queries.ts";

const GROUP_DIR = process.env.WORKSPACE_GROUP ?? "/workspace/group";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const DEFAULT_QUERY = "newer_than:1d -category:promotions";
const DEFAULT_MAX_RESULTS = 50;

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

function rawPath(messageId: string, timestamp: Date): string {
  const y = timestamp.getUTCFullYear();
  const m = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  const d = String(timestamp.getUTCDate()).padStart(2, "0");
  return resolve(GROUP_DIR, "data", "raw", "gmail", String(y), m, d, `${messageId}.json`);
}

function getAccessToken(): string {
  const token = process.env.GMAIL_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "GMAIL_ACCESS_TOKEN not set. Inside containers, OneCLI injects this automatically. " +
        "For local testing, set it manually or use 'gcloud auth print-access-token'.",
    );
  }
  return token;
}

async function gmailFetch(path: string, token: string): Promise<any> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API ${res.status}: ${body}`);
  }
  return res.json();
}

function decodeBase64Url(data: string): string {
  const padded = data + "=".repeat((4 - (data.length % 4)) % 4);
  return Buffer.from(padded, "base64url").toString("utf-8");
}

function extractText(payload: any): string {
  const mimeType = payload.mimeType ?? "";
  const bodyData = payload.body?.data;

  if (mimeType === "text/plain" && bodyData) {
    return decodeBase64Url(bodyData);
  }

  const parts: string[] = [];
  for (const part of payload.parts ?? []) {
    const text = extractText(part);
    if (text) parts.push(text);
  }
  if (parts.length) return parts.join("\n");

  return bodyData ? decodeBase64Url(bodyData) : "";
}

function extractHeaders(payload: any): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of payload.headers ?? []) {
    headers[h.name] = h.value;
  }
  return headers;
}

async function main() {
  const db = getDb();
  initSchema(db);

  const token = getAccessToken();
  const query: string = getAppState("gmail_query") ?? DEFAULT_QUERY;
  const maxResults = DEFAULT_MAX_RESULTS;

  console.log(`Querying Gmail: "${query}" (max ${maxResults})`);

  // List messages
  const listRes = await gmailFetch(
    `/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    token,
  );
  const messages: Array<{ id: string }> = listRes.messages ?? [];

  if (!messages.length) {
    console.log("No messages found.");
    closeDb();
    return;
  }

  console.log(`Found ${messages.length} messages, fetching...`);

  let totalNew = 0;
  let totalUpdated = 0;

  for (const { id } of messages) {
    const raw = await gmailFetch(`/users/me/messages/${id}?format=full`, token);
    const payload = raw.payload ?? {};
    const headers = extractHeaders(payload);

    const subject = headers.Subject ?? null;
    const author = headers.From ?? null;
    const internalDateMs = Number(raw.internalDate ?? 0);
    const timestamp = new Date(internalDateMs);

    let bodyText = normalizeWhitespace(extractText(payload) || raw.snippet || "");
    if (!bodyText) continue;

    const labels: string[] = raw.labelIds ?? [];
    const rp = rawPath(id, timestamp);
    writeJson(rp, raw);

    const scoring = scoreSourceItem({
      source: "gmail",
      author,
      title: subject,
      text: bodyText,
      metadata: { labels, snippet: raw.snippet },
    });

    const enrichedMeta = {
      labels,
      history_id: raw.historyId,
      snippet: raw.snippet,
      harvest_score: scoring.score,
      harvest_signals: scoring.signals,
      source_patterns: scoring.patterns,
      harvest_breakdown: scoring.breakdown,
    };

    const { isNew } = upsertSourceItem({
      source: "gmail",
      external_id: id,
      thread_ref: String(raw.threadId ?? id),
      author,
      title: subject,
      text: bodyText,
      channel_or_label: labels.join(","),
      timestamp_utc: timestamp.toISOString(),
      raw_path: rp,
      content_hash: hashText(`${subject ?? ""}\n${bodyText}`),
      metadata_json: enrichedMeta,
    });

    if (isNew) totalNew++;
    else totalUpdated++;
  }

  setAppState("gmail_last_harvest", new Date().toISOString());

  console.log(`\nDone. New: ${totalNew}, Updated: ${totalUpdated}`);
  closeDb();
}

main().catch((err) => {
  console.error("Gmail ingestion failed:", err);
  process.exit(1);
});
