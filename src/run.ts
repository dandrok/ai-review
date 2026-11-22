import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiff, numberedDiff } from './diff.ts';
import { diffFor, defaultBase, repoRoot, type DiffMode } from './git.ts';
import { loadConfig, ignored, type Config, type FailOn, type Effort } from './config.ts';
import { staticFindings } from './static.ts';
import { buildContext } from './context.ts';
import { buildMessages } from './prompt.ts';
import { callModel } from './llm.ts';
import { groundFindings } from './grounding.ts';
import { dedupFindings, assignIds } from './dedup.ts';
import { countBlockers, renderTerminal, toReviewPayload } from './gate.ts';
import { detectGh, postReview } from './github.ts';
import { loadEnv } from './env.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface RunOptions {
  mode: DiffMode;
  base?: string | null;
  staticOnly?: boolean;
  dryRun?: boolean;
  mock?: string;
  post?: boolean;
  format?: 'terminal' | 'json' | 'markdown';
  quiet?: boolean;
  prTitle?: string;
  prBody?: string;
  failOn?: FailOn;
  effort?: Effort;
  model?: string;
  maxFindings?: number;
  packs?: string[];
}
export function loadPacks(root: string, ids: string[]): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  for (const id of ids) {
    const local = join(root, '.ai-review', 'packs', `${id}.md`);
    const bundled = join(HERE, '..', 'packs', `${id}.md`);
    const p = existsSync(local) ? local : bundled;
    if (!existsSync(p)) continue;
    out.push({ id, text: readFileSync(p, 'utf8') });
  }
  return out;
}

function prFromEvent(): { title?: string; body?: string } {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p) return {};
  try {
    const ev = JSON.parse(readFileSync(p, 'utf8'));
    return { title: ev?.pull_request?.title, body: ev?.pull_request?.body ?? '' };
  } catch {
    return {};
  }
}

export async function runReview(opts: RunOptions): Promise<{ exitCode: number }> {
  const say = (s: string) => { if (!opts.quiet) process.stderr.write(s + '\n'); };
  const root = repoRoot();
  try { process.chdir(root); } catch { /* keep cwd */ }
  const { config: fileCfg, source } = loadConfig(root, {
    fail_on: opts.failOn,
    effort: opts.effort,
    model: opts.model,
    max_findings: opts.maxFindings,
    packs: opts.packs,
  } as Partial<Config>);

  const base = opts.base ?? (opts.mode === 'range' ? defaultBase() : null);
  const { raw, label } = diffFor(opts.mode, base);
  const diff = parseDiff(raw);

  const kept = diff.files.filter((f) => !ignored(f.path, fileCfg.ignore));
  if (kept.length !== diff.files.length) {
    diff.files = kept;
    diff.raw = raw;
  }
  if (!diff.files.length) {
    say(`ai-review: nothing to review (${label}).`);
    if (opts.format === 'json') console.log(JSON.stringify({ summary: 'no changes', findings: [] }, null, 2));
    return { exitCode: 0 };
  }

  // Step 0 — free, deterministic.
  const staticHits = staticFindings(diff);
  say(`ai-review: ${diff.files.length} file(s) changed, ${staticHits.length} static hit(s) · ${label}`);

  if (opts.staticOnly) {
    const payload = toReviewPayload({
      findings: staticHits, droppedCount: 0, diff, agent: 'static', failOn: fileCfg.fail_on,
      summary: 'Deterministic scan only (no model call).', model: 'static', costUsd: 0, gate: true,
      contextChars: 0, diffChars: raw.length,
    });
    if (opts.format === 'json') console.log(JSON.stringify({ findings: staticHits }, null, 2));
    else console.log(renderTerminal(payload, staticHits, [], process.stdout.isTTY === true));
    return { exitCode: countBlockers(staticHits, fileCfg.fail_on) > 0 ? 1 : 0 };
  }

  // Step 1 — context bundle.
  const event = prFromEvent();
  const prTitle = opts.prTitle ?? event.title ?? '';
  const prBody = opts.prBody ?? event.body ?? '';
  const ctx = buildContext({ root, diff, prBody, budget: fileCfg.budget_chars });
  const numbered = numberedDiff(diff);
  const packs = loadPacks(root, fileCfg.packs);
  if (!packs.length) throw new Error(`no packs found for: ${fileCfg.packs.join(', ')}`);

  if (opts.dryRun) {
    say('— context plan —');
    for (const l of ctx.log) say('  ' + l);
    say(`  diff: ${numbered.length} chars · context: ${ctx.chars}/${fileCfg.budget_chars} chars · packs: ${packs.map((p) => p.id).join(', ')}`);
    return { exitCode: 0 };
  }

  loadEnv(root, root);
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.AI_REVIEW_API_KEY || '';
  if (!apiKey && !opts.mock) throw new Error('DEEPSEEK_API_KEY is not set (needed unless --mock is used)');

  // Step 2 — one model call, all packs merged into one system prompt.
  const messages = buildMessages({
    agent: { id: 'review', prompt: packs.map((p) => p.text).join('\n\n---\n\n') },
    diff: numbered,
    prTitle,
    prBody,
    context: ctx.blocks,
    maxFindings: fileCfg.max_findings,
    language: fileCfg.language,
  });

  const result = await callModel(messages, {
    apiKey,
    model: fileCfg.model,
    baseUrl: process.env.AI_REVIEW_BASE_URL || 'https://api.deepseek.com',
    effort: fileCfg.effort,
    maxTokens: fileCfg.max_output_tokens,
    mockPath: opts.mock,
    onRetry: (note) => say(`ai-review: retry (${note})`),
  });

  // Step 3 — grounding, then dedup, then the deterministic cap.
  const grounded = groundFindings([...staticHits, ...result.review.findings], diff);
  const RANK: Record<string, number> = { CRITICAL: 3, WARNING: 2, SUGGESTION: 1 };
  const merged = assignIds(
    dedupFindings(grounded.kept)
      .sort((a, b) => (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0))
      .slice(0, fileCfg.max_findings),
  );

  const payload = toReviewPayload({
    findings: merged,
    droppedCount: grounded.dropped.length,
    diff,
    agent: packs.map((p) => p.id).join('+'),
    failOn: fileCfg.fail_on,
    summary: result.review.summary,
    model: result.model,
    costUsd: result.cost_usd,
    gate: true,
    contextChars: ctx.chars,
    diffChars: numbered.length,
  });

  // Step 4 — persist + emit.
  const artifactDir = join(root, '.ai-review');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, 'last.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        base: base ?? null,
        label,
        configSource: source,
        packs: packs.map((p) => p.id),
        model: result.model,
        usage: result.usage,
        cost_usd: result.cost_usd,
        context_log: ctx.log,
        summary: result.review.summary,
        findings: merged,
        dropped: grounded.dropped.map((d) => ({ file: d.finding.file, line: d.finding.start_line, reason: d.reason })),
      },
      null,
      2,
    ),
  );

  const wantPost = opts.post ?? (process.env.AI_REVIEW_POST !== 'false' && fileCfg.post);
  const gh = wantPost ? detectGh() : null;
  if (gh) {
    const res = await postReview(gh, payload);
    say(`ai-review: posted review to ${gh.repo}#${gh.pr} (${res.inline} inline${res.fallback ? ', summary-only fallback' : ''})`);
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify({ summary: result.review.summary, findings: merged, cost_usd: result.cost_usd, usage: result.usage }, null, 2));
  } else if (opts.format === 'markdown') {
    console.log(payload.body);
  } else if (!opts.quiet || merged.length) {
    console.log(renderTerminal(payload, merged, grounded.dropped, process.stdout.isTTY === true));
  }

  const blockers = countBlockers(merged, fileCfg.fail_on);
  if (blockers > 0) say(`ai-review: ${blockers} finding(s) at or above '${fileCfg.fail_on}'`);
  return { exitCode: blockers > 0 ? 1 : 0 };
}
