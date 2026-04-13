const CHANNELS_WITH_NATIVE_MARKERS = new Set([
  'telegram',
  'whatsapp',
  'slack',
]);

function protectCodeSegments(text: string): {
  text: string;
  restore: (value: string) => string;
} {
  const segments: string[] = [];
  const stash = (segment: string): string => {
    const index = segments.push(segment) - 1;
    return `@@CODE_SEGMENT_${index}@@`;
  };

  let protectedText = text.replace(/```[\s\S]*?```/g, stash);
  protectedText = protectedText.replace(/`[^`\n]+`/g, stash);

  return {
    text: protectedText,
    restore: (value: string) =>
      value.replace(/@@CODE_SEGMENT_(\d+)@@/g, (_match, index) => {
        const segment = segments[Number(index)];
        return segment ?? '';
      }),
  };
}

function flattenMarkdownLinks(text: string, channel: string): string {
  return text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) => {
      const trimmedLabel = label.trim();
      if (trimmedLabel === url) return url;
      if (channel === 'slack') return `<${url}|${trimmedLabel}>`;
      return `${trimmedLabel}: ${url}`;
    },
  );
}

function convertSingleAsteriskItalic(text: string): string {
  return text.replace(
    /(?<!\*)\*(?![\s*])([^*\n]+?)(?<!\s)\*(?!\*)/g,
    '_$1_',
  );
}

function convertDoubleAsteriskBold(text: string): string {
  return text.replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, '*$1*');
}

function convertMarkdownHeadings(text: string): string {
  return text.replace(
    /^(#{1,6})\s+(.+?)\s*#*\s*$/gm,
    (_match, _hashes: string, title: string) => `*${title.trim()}*`,
  );
}

export function parseTextStyles(text: string, channel?: string): string {
  if (!channel || !CHANNELS_WITH_NATIVE_MARKERS.has(channel)) return text;

  const { text: protectedText, restore } = protectCodeSegments(text);
  let formatted = protectedText;

  formatted = flattenMarkdownLinks(formatted, channel);
  formatted = convertSingleAsteriskItalic(formatted);
  formatted = convertDoubleAsteriskBold(formatted);
  formatted = convertMarkdownHeadings(formatted);

  return restore(formatted);
}
