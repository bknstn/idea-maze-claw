/**
 * One-time Telegram user session auth.
 *
 * Run interactively to generate a GramJS StringSession, then store it:
 *   WORKSPACE_GROUP=... tsx auth-telegram.ts
 *
 * Requires TELEGRAM_API_ID and TELEGRAM_API_HASH in environment (from my.telegram.org).
 * Stores the session string in app_state key "telegram_session".
 */

import * as readline from "node:readline";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { getDb, closeDb } from "./lib/db.ts";
import { initSchema } from "./lib/schema.ts";
import { setAppState, getAppState } from "./lib/queries.ts";

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
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

  const existing: string | null = getAppState("telegram_session");
  if (existing) {
    console.log("A session already exists in app_state. Delete it first if you want to re-auth.");
    console.log("  tsx -e \"import {setAppState} from './lib/queries.ts'; setAppState('telegram_session', null)\"");
    closeDb();
    process.exit(0);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: () => prompt(rl, "Phone number (with country code, e.g. +1234567890): "),
    password: () => prompt(rl, "2FA password (leave blank if none): "),
    phoneCode: () => prompt(rl, "Verification code: "),
    onError: (err) => console.error("Auth error:", err),
  });

  const sessionString = client.session.save() as unknown as string;
  setAppState("telegram_session", sessionString);
  console.log("\nSession saved to app_state key 'telegram_session'.");

  await client.disconnect();
  rl.close();
  closeDb();
}

main().catch((err) => {
  console.error("Auth failed:", err);
  process.exit(1);
});
