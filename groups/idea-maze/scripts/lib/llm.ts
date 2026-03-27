/**
 * Minimal Anthropic API client for running inside NanoClaw containers.
 *
 * Uses the ANTHROPIC_API_KEY environment variable (injected by OneCLI
 * or set directly). Falls back gracefully when no key is available.
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";

export function isLlmConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function generateJson<T>(
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }

  const data = await res.json();
  const text: string = data.content?.[0]?.text ?? "";

  // Extract JSON from response — handle markdown code fences
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in LLM response: ${text.slice(0, 200)}`);
  }

  return JSON.parse(jsonMatch[1].trim()) as T;
}
