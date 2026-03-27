/**
 * Telegram channel ingestion — STUB.
 *
 * Full implementation requires GramJS (telegram npm package) for user-session
 * MTProto access to read channel posts. This is deferred until Telegram
 * setup is complete.
 *
 * When ready to implement:
 * 1. Add `telegram` to the container Dockerfile global installs
 * 2. Create a user session string (interactive auth, one-time)
 * 3. Store session in app_state key "telegram_session"
 * 4. Store channel allowlist in app_state key "telegram_channels"
 *
 * The connector will:
 * - Read followed channel posts via user-session auth
 * - Write raw records to data/raw/telegram/
 * - Normalize views, forwards, reply counts into source_items.metadata_json
 * - Compute harvest scores with engagement-weighted scoring
 *
 * Usage (once implemented): tsx ingest-telegram.ts
 */

import { getAppState } from "./lib/queries.ts";

async function main() {
  const channels: string[] = getAppState("telegram_channels") ?? [];
  const session: string | null = getAppState("telegram_session");

  if (!session) {
    console.error("Telegram channel ingestion not configured.");
    console.error("This connector requires a GramJS user session.");
    console.error("See the script comments for setup instructions.");
    process.exit(1);
  }

  if (!channels.length) {
    console.error("No channels configured. Set app_state key 'telegram_channels' first.");
    process.exit(1);
  }

  // TODO: Implement with GramJS
  // 1. const { TelegramClient } = await import("telegram");
  // 2. const { StringSession } = await import("telegram/sessions");
  // 3. Initialize client with session string
  // 4. For each channel: client.getMessages(channel, { limit: 200 })
  // 5. Filter by time window
  // 6. Write raw JSON, normalize to source_items, compute scores

  console.error("Telegram channel ingestion is not yet implemented.");
  console.error(`Would ingest from ${channels.length} channels: ${channels.join(", ")}`);
  process.exit(1);
}

main();
