import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

function splitTableCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitTableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isMarkdownTableHeader(line: string): boolean {
  const cells = splitTableCells(line);
  return cells.length >= 2 && cells.some((cell) => cell.length > 0);
}

function isMarkdownTableRow(line: string): boolean {
  const cells = splitTableCells(line);
  return line.includes('|') && cells.length >= 2;
}

function formatTableRow(headers: string[], row: string[]): string {
  const cells = headers
    .map((header, index) => ({
      header,
      value: row[index]?.trim() ?? '',
    }))
    .filter((cell) => cell.value.length > 0);

  if (cells.length === 0) return '';

  if (cells.length === 2 && row[0]?.trim()) {
    return `- ${row[0].trim()}: ${row[1]?.trim() ?? ''}`.trimEnd();
  }

  return `- ${cells.map((cell) => `${cell.header}: ${cell.value}`).join('; ')}`;
}

function normalizeMarkdownTables(text: string): string {
  const fencedCodeBlock = /```[\s\S]*?```/g;
  let result = '';
  let lastIndex = 0;

  const transformSegment = (segment: string): string => {
    const lines = segment.split('\n');
    const output: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (
        i + 1 < lines.length &&
        isMarkdownTableHeader(lines[i]) &&
        isMarkdownTableSeparator(lines[i + 1])
      ) {
        const headers = splitTableCells(lines[i]);
        const rows: string[] = [];
        let j = i + 2;

        while (j < lines.length && isMarkdownTableRow(lines[j])) {
          const formatted = formatTableRow(headers, splitTableCells(lines[j]));
          if (formatted) rows.push(formatted);
          j++;
        }

        if (rows.length > 0) {
          output.push(...rows);
          i = j - 1;
          continue;
        }
      }

      output.push(lines[i]);
    }

    return output.join('\n');
  };

  for (const match of text.matchAll(fencedCodeBlock)) {
    const index = match.index ?? 0;
    result += transformSegment(text.slice(lastIndex, index));
    result += match[0];
    lastIndex = index + match[0].length;
  }

  result += transformSegment(text.slice(lastIndex));
  return result;
}

export function formatOutbound(rawText: string): string {
  const text = normalizeMarkdownTables(stripInternalTags(rawText));
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
