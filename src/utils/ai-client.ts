const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

export interface AIClientConfig {
  api_key?: string;
  api_base_url?: string;
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function normalizeAIResponseKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const normalized = key.replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase());
    const snaked = normalized.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
    if (key === 'decisions' || snaked === 'decisions') {
      result.decisions = value;
    } else if (key === 'pain_points' || snaked === 'pain_points' || normalized === 'painPoints') {
      result.pain_points = value;
    } else if (key === 'preferences' || snaked === 'preferences') {
      result.preferences = value;
    } else if (key === 'sections' || snaked === 'sections') {
      result.sections = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export async function callAI(
  systemPrompt: string,
  userContent: string,
  config: AIClientConfig,
  model: string,
  maxTokens: number = 2048,
): Promise<string | null> {
  const apiKey = config.api_key || process.env.ANTHROPIC_API_KEY;
  const baseUrl = config.api_base_url || process.env.ANTHROPIC_API_BASE_URL || 'https://api.anthropic.com';

  if (!apiKey) return null;

  const isAnthropicNative = baseUrl.includes('api.anthropic.com');

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      let res: Response;

      if (isAnthropicNative) {
        res = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [{ role: 'user', content: userContent }],
          }),
        });
      } else {
        res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent },
            ],
          }),
        });
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (isRetryable(res.status) && attempt < MAX_RETRIES) {
          const retryAfter = parseInt(res.headers.get('retry-after') ?? '', 10);
          const delayMs = (Number.isFinite(retryAfter) && retryAfter > 0)
            ? retryAfter * 1000
            : RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500;
          console.warn(`  AI API ${res.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delayMs)}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        console.error(`  AI API error: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
        return null;
      }

      const data = await res.json();

      if (isAnthropicNative) {
        const text = data.content?.find((c: { type: string; text?: string }) => c.type === 'text')?.text;
        return text ?? null;
      }

      return data.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delayMs = RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500;
        console.warn(`  AI call error, retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delayMs)}ms: ${err instanceof Error ? err.message : err}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      console.error(`  AI call failed after ${MAX_RETRIES} retries:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  return null;
}

export function parseJSON<T>(text: string | null): T | null {
  if (!text) return null;

  const trimmedText = text.trim();
  const candidates = [trimmedText];
  const jsonMatch = trimmedText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch?.[1]) {
    candidates.unshift(jsonMatch[1].trim());
  }

  const objectStart = trimmedText.indexOf('{');
  const objectEnd = trimmedText.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd > objectStart) {
    candidates.push(trimmedText.slice(objectStart, objectEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return normalizeAIResponseKeys(parsed) as T;
    } catch {
      continue;
    }
  }

  return null;
}
