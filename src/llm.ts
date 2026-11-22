import { readFileSync } from 'node:fs';
import { validateReview, type Review } from './schema.ts';
import type { Effort } from './config.ts';

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
}

export interface CallResult {
  review: Review;
  usage: Usage;
  cost_usd: number;
  attempts: number;
  model: string;
}

export interface LlmOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  effort: Effort;
  maxTokens: number;
  mockPath?: string;
  onRetry?: (note: string) => void;
}

/**
 * USD per 1M tokens, `[off-peak, peak]`, copied by hand from DeepSeek's published rates:
 * https://api-docs.deepseek.com/quick_start/pricing — that page wins over this table.
 *
 * Only used to print an estimate in the summary. It is a hardcoded copy of a price list, so it
 * drifts silently; if the number in the footer ever matters, read it from the API, not from here.
 */
const PRICES = {
  'deepseek-flash': { hit: [0.003, 0.006], miss: [0.15, 0.3], out: [0.6, 1.2] },
  'deepseek-v4-pro': { hit: [0.022, 0.044], miss: [0.66, 1.32], out: [1.98, 3.96] },
} as const;

/**
 * Peak windows as this tool assumes them: 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri, everything
 * else at half price. Verify against the pricing page above before trusting a peak/off-peak split.
 */
export function isPeak(now = new Date()): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = now.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export function estimateCost(model: string, usage: Usage, now = new Date()): number {
  const key = (Object.keys(PRICES) as (keyof typeof PRICES)[]).find((k) => model.includes(k)) ?? 'deepseek-flash';
  const p = PRICES[key];
  const i = isPeak(now) ? 1 : 0;
  return (
    (usage.cache_hit_tokens * p.hit[i]) / 1e6 +
    (usage.cache_miss_tokens * p.miss[i]) / 1e6 +
    (usage.completion_tokens * p.out[i]) / 1e6
  );
}

function readUsage(json: any): Usage {
  const u = json?.usage ?? {};
  const prompt = Number(u.prompt_tokens ?? 0);
  const hit = Number(u.prompt_cache_hit_tokens ?? 0);
  const miss = Number(u.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit));
  return { prompt_tokens: prompt, completion_tokens: Number(u.completion_tokens ?? 0), cache_hit_tokens: hit, cache_miss_tokens: miss };
}

async function post(
  opts: LlmOptions,
  messages: { role: string; content: string }[],
  extra: { role: string; content: string }[],
  effort: Effort,
) {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [...messages, ...extra],
    response_format: { type: 'json_object' },
    max_tokens: opts.maxTokens,
    stream: false,
  };
  if (effort === 'none') body.thinking = { type: 'disabled' };
  else {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = effort;
  }
  const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error(`model API ${res.status}: ${(await res.text()).slice(0, 400)}`), { status: res.status });
  return (await res.json()) as any;
}

export async function callModel(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], opts: LlmOptions): Promise<CallResult> {
  if (opts.mockPath) {
    const review = JSON.parse(readFileSync(opts.mockPath, 'utf8'));
    const v = validateReview(review);
    if (!v.review) throw new Error(`mock file is not a valid review: ${v.errors.join('; ')}`);
    return { review: v.review, usage: { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 }, cost_usd: 0, attempts: 0, model: 'mock' };
  }

  const extra: { role: string; content: string }[] = [];
  let lastErrors: string[] = [];
  // Thinking costs output tokens. When the budget runs out mid-reasoning the model
  // returns empty content, so a retry with the same settings is useless — turn
  // thinking off after the first failure and keep the answer.
  let effort: Effort = opts.effort;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let json: any;
    try {
      json = await post(opts, messages as any, extra, effort);
    } catch (e: any) {
      const status = e?.status as number | undefined;
      if (attempt < 3 && (status === 429 || status === 503 || status === 500)) {
        opts.onRetry?.(`HTTP ${status}, retrying`);
        await new Promise((r) => setTimeout(r, 1200 * attempt));
        continue;
      }
      throw e;
    }
    const content: string = json?.choices?.[0]?.message?.content ?? '';
    const usage = readUsage(json);
    const finish = String(json?.choices?.[0]?.finish_reason ?? 'unknown');
    if (!content.trim()) {
      const reasoning = String(json?.choices?.[0]?.message?.reasoning_content ?? '').length;
      lastErrors = [`empty response (finish_reason=${finish}, reasoning=${reasoning} chars, completion_tokens=${usage.completion_tokens})`];
      extra.length = 0;
      extra.push({ role: 'user', content: 'Your reply was empty. Reply with the JSON object only, no prose and no markdown fence.' });
      effort = 'none';
      opts.onRetry?.(lastErrors[0]);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
      try {
        parsed = JSON.parse(fenced ? fenced[1] : content.replace(/^[^{[]*/, ''));
      } catch {
        lastErrors = ['response was not valid JSON'];
        extra.length = 0;
        extra.push({ role: 'assistant', content: content.slice(0, 500) });
        extra.push({ role: 'user', content: 'That was not valid JSON. Return only the JSON object described in the instructions.' });
        opts.onRetry?.('invalid JSON, retrying');
        continue;
      }
    }
    const v = validateReview(parsed);
    if (!v.review) {
      lastErrors = v.errors;
      extra.length = 0;
      extra.push({ role: 'user', content: `That JSON failed validation: ${v.errors.slice(0, 8).join('; ')}. Return corrected JSON for the same review.` });
      opts.onRetry?.(`${v.errors.length} schema error(s), retrying`);
      continue;
    }
    const review = v.review;
    return { review, usage, cost_usd: estimateCost(opts.model, usage), attempts: attempt, model: opts.model };
  }
  throw new Error(`model did not return a valid review after 3 attempts: ${lastErrors.join('; ')}`);
}
