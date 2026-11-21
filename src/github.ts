import { readFileSync } from 'node:fs';
import type { ReviewPayload } from './gate.ts';

export interface GhContext {
  token: string;
  repo: string;
  pr: number;
  sha?: string;
}

export function detectGh(): GhContext | null {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const repo = process.env.GITHUB_REPOSITORY || '';
  if (!token || !repo) return null;
  let pr = Number(process.env.PR_NUMBER ?? 0);
  if (!pr) {
    const ref = process.env.GITHUB_REF ?? '';
    const m = /refs\/pull\/(\d+)\//.exec(ref);
    if (m) pr = Number(m[1]);
  }
  if (!pr && process.env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      pr = Number(event?.pull_request?.number ?? event?.issue?.number ?? 0);
    } catch {
      /* ignore */
    }
  }
  if (!pr) return null;
  return { token, repo, pr, sha: process.env.GITHUB_SHA };
}

async function api(ctx: GhContext, path: string, body: unknown): Promise<Response> {
  return fetch(`https://api.github.com/repos/${ctx.repo}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ctx.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'ai-review',
    },
    body: JSON.stringify(body),
  });
}

/**
 * Posts one review with inline comments. If GitHub rejects the anchoring (422 —
 * usually a line that a force-push moved), fall back to the summary-only review
 * so the run still reports something.
 */
export async function postReview(ctx: GhContext, payload: ReviewPayload): Promise<{ inline: number; fallback: boolean }> {
  const first = await api(ctx, `/pulls/${ctx.pr}/reviews`, {
    body: payload.body,
    event: payload.event,
    comments: payload.comments,
    ...(ctx.sha ? { commit_id: ctx.sha } : {}),
  });
  if (first.ok) return { inline: payload.comments.length, fallback: false };

  const detail = (await first.text()).slice(0, 300);
  const body = `${payload.body}\n\n> Inline comments could not be anchored (${first.status}): ${detail}\n\n${payload.comments
    .map((c) => `- \`${c.path}:${c.line}\` — ${c.body.split('\n')[0]}`)
    .join('\n')}`;
  const second = await api(ctx, `/pulls/${ctx.pr}/reviews`, { body, event: payload.event, ...(ctx.sha ? { commit_id: ctx.sha } : {}) });
  if (!second.ok) throw new Error(`GitHub review failed: ${second.status} ${(await second.text()).slice(0, 300)}`);
  return { inline: 0, fallback: true };
}
