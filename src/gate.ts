import type { Finding } from './schema.ts';
import type { FailOn } from './config.ts';
import type { UnifiedDiff } from './diff.ts';
import { anchorLine } from './grounding.ts';

const RANK: Record<string, number> = { SUGGESTION: 1, WARNING: 2, CRITICAL: 3 };
const MIN: Record<FailOn, number> = { never: Infinity, critical: 3, warning: 2, any: 1 };
export const ICON: Record<string, string> = { CRITICAL: '🔴', WARNING: '🟡', SUGGESTION: '🔵' };

/** The gate is computed from severities in code. The model's own verdict is never used. */
export function countBlockers(findings: Finding[], failOn: FailOn): number {
  return findings.filter((f) => (RANK[f.severity] ?? 0) >= MIN[failOn]).length;
}

export function commentBody(f: Finding, agent: string): string {
  const payload = JSON.stringify({
    v: 1,
    id: f.id,
    rule: f.category,
    severity: f.severity,
    file: f.file,
    line: f.start_line,
    end_line: f.end_line,
  });
  return [
    `${ICON[f.severity]} **${f.title}** (${f.severity.toLowerCase()} · ${f.category} · ${agent})`,
    '',
    f.rationale,
    f.suggestion ? `\n**Fix:** ${f.suggestion}` : '',
    '',
    `<!-- ai-review:v1 ${payload} -->`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export interface ReviewPayload {
  body: string;
  event: 'COMMENT' | 'REQUEST_CHANGES';
  comments: { path: string; line: number; body: string }[];
}

export function toReviewPayload(opts: {
  findings: Finding[];
  droppedCount: number;
  diff: UnifiedDiff;
  agent: string;
  failOn: FailOn;
  summary: string;
  model: string;
  costUsd: number;
  gate: boolean;
  contextChars: number;
  diffChars: number;
}): ReviewPayload {
  const blockers = countBlockers(opts.findings, opts.failOn);
  const event: ReviewPayload['event'] = opts.gate && blockers > 0 ? 'REQUEST_CHANGES' : 'COMMENT';

  const comments = opts.findings.flatMap((f) => {
    const line = anchorLine(f, opts.diff);
    return line === null ? [] : [{ path: f.file, line, body: commentBody(f, opts.agent) }];
  });

  const counts = opts.findings.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }), {});
  const header =
    opts.findings.length === 0
      ? '## 🤖 AI review — no findings'
      : `## 🤖 AI review — ${blockers} blocker(s), ${opts.findings.length} finding(s)${
          opts.gate && blockers ? ' · changes requested' : ''
        }`;

  const table =
    opts.findings.length > 0
      ? [
          '| Sev | Finding | Where |',
          '|---|---|---|',
          ...opts.findings.map((f) => `| ${ICON[f.severity]} ${f.severity.toLowerCase()} | ${f.title} | \`${f.file}:${f.start_line}\` |`),
        ].join('\n')
      : '_Nothing worth flagging on this diff._';

  const footer = [
    `_${opts.model} · ${opts.findings.length} kept, ${opts.droppedCount} dropped as ungrounded · ${opts.contextChars} ctx + ${opts.diffChars} diff chars · $${opts.costUsd.toFixed(4)}_`,
    '_Findings are grounded to diff lines; the verdict is computed from severities in code, not by the model. A human merges._',
  ].join('\n\n');

  return {
    event,
    comments,
    body: [header, '', opts.summary, '', table, '', footer].join('\n'),
  };
}

export function renderTerminal(payload: ReviewPayload, findings: Finding[], dropped: { finding: Finding; reason: string }[], color: boolean): string {
  const paint = (c: string, s: string) => (color ? `\x1b[${c}m${s}\x1b[0m` : s);
  const lines: string[] = [];
  lines.push(payload.body.split('\n\n')[0]);
  lines.push('');
  for (const f of findings) {
    const sev = f.severity === 'CRITICAL' ? paint('31;1', 'CRITICAL') : f.severity === 'WARNING' ? paint('33;1', 'WARNING') : paint('36', 'SUGGESTION');
    lines.push(`${ICON[f.severity]} ${sev} ${paint('1', f.title)}`);
    lines.push(`   ${paint('2', `${f.file}:${f.start_line}`)} · ${f.category}`);
    for (const l of f.rationale.split('\n')) lines.push(`   ${l}`);
    if (f.suggestion) lines.push(`   ${paint('32', 'Fix:')} ${f.suggestion}`);
    lines.push('');
  }
  if (dropped.length) {
    lines.push(paint('2', `${dropped.length} finding(s) dropped as ungrounded:`));
    for (const d of dropped.slice(0, 5)) lines.push(paint('2', `  - ${d.finding.file}:${d.finding.start_line} — ${d.reason}`));
    lines.push('');
  }
  lines.push(paint('2', payload.body.split('\n\n').at(-1) ?? ''));
  return lines.join('\n');
}
