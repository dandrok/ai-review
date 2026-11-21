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

const range = (f: Finding) => (f.end_line !== f.start_line ? `${f.file}:${f.start_line}-${f.end_line}` : `${f.file}:${f.start_line}`);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function payloadFor(f: Finding): string {
  return JSON.stringify({
    v: 1,
    id: f.id,
    rule: f.category,
    severity: f.severity,
    file: f.file,
    line: f.start_line,
    end_line: f.end_line,
  });
}

/**
 * One prompt for the whole review. The model is told to verify each finding and to skip
 * what it cannot justify: the reviewer saw the diff and a slice of context, so some
 * findings are wrong or need a decision that is not its to make.
 */
export function agentPrompt(findings: Finding[]): string {
  const body = findings
    .map((f) =>
      [
        '---',
        `id: ${f.id}`,
        `severity: ${f.severity.toLowerCase()}`,
        `category: ${f.category}`,
        `location: ${range(f)}`,
        `title: ${f.title}`,
        `why: ${oneLine(f.rationale)}`,
        f.suggestion ? `fix: ${oneLine(f.suggestion)}` : '',
        '---',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');

  return `# Code review findings — verify each one, then fix or skip

You are working in this repository. The findings below come from an automated review of a
diff. They are leads, not instructions: the reviewer saw the diff and a slice of repository
context, never the whole system. Some are wrong, some are already handled elsewhere, and
some need a decision that is not yours to make.

## Decide before you edit
For each finding, read the code at the cited location and its callers first, then pick one:
- FIXED — the defect is real and the correction is contained.
- SKIPPED — say why in one line: false positive, unreachable in practice, already handled
  elsewhere, or needs a decision (API shape, schema, product behaviour, cost).

Never apply a change you cannot justify from the code in front of you. A wrong fix costs
more than a skipped finding.

## Rules
- The smallest change that removes the root cause. No refactors, renames or reformatting.
- One finding at a time. If two conflict, fix the more severe one and say which you skipped.
- Touch nothing outside the cited ranges unless the fix requires it — then say what and why.
- No new dependencies. No deleted or weakened tests. No unrelated files.

## Report
For every finding: id, verdict, one line of reasoning, files touched.

## Findings (${findings.length})

${body}
`;
}

/** Human-facing block, used inside the summary's single expand. */
export function readableBlock(f: Finding): string {
  return [
    `**${ICON[f.severity]} ${escapeHtml(f.title)}**`,
    `\`${range(f)}\` · ${f.severity.toLowerCase()} · ${f.category}`,
    '',
    f.rationale,
    f.suggestion ? `\n**Fix:** ${f.suggestion}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Inline comment: readable on arrival. No nested expand, nothing to click. */
export function commentBody(f: Finding, agent: string): string {
  return [
    `${ICON[f.severity]} **${f.title}** — \`${range(f)}\``,
    `_${f.severity.toLowerCase()} · ${f.category} · ${agent}_`,
    '',
    f.rationale,
    f.suggestion ? `\n**Fix:** ${f.suggestion}` : '',
    '',
    `<!-- ai-review:v1 ${payloadFor(f)} -->`,
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
          '',
          // One expand, not one per finding: inside is everything, including one block to copy.
          `<details><summary><b>All ${opts.findings.length} finding(s)</b> — read them, or copy the block into your agent</summary>`,
          '',
          ...opts.findings.map((f) => `${readableBlock(f)}\n\n---`),
          '',
          `<b>Copy all ${opts.findings.length} into an agent</b> (the fence has a copy button):`,
          '',
          '```text',
          agentPrompt(opts.findings),
          '```',
          '',
          '</details>',
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
    lines.push(`   ${paint('2', range(f))} · ${f.category}`);
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
