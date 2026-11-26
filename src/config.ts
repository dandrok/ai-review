import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Severity = 'CRITICAL' | 'WARNING' | 'SUGGESTION';
export type FailOn = 'never' | 'critical' | 'warning' | 'any';
export type Effort = 'none' | 'low' | 'high' | 'max';

export interface Config {
  model: string;
  effort: Effort;
  fail_on: FailOn;
  max_findings: number;
  budget_chars: number;
  /** output token budget for one call; thinking tokens are spent from it too */
  max_output_tokens: number;
  packs: string[];
  ignore: string[];
  /** free-text hint about the stack; '' = let the model infer */
  language: string;
  /** post to the PR when running in CI */
  post: boolean;
}

export const DEFAULTS: Config = {
  model: 'deepseek-flash',
  effort: 'high',
  fail_on: 'critical',
  max_findings: 8,
  budget_chars: 60_000,
  max_output_tokens: 16_000,
  packs: ['security', 'correctness', 'performance'],
  ignore: ['**/*.md', '**/*.lock', '**/package-lock.json', '**/dist/**', '**/node_modules/**'],
  language: '',
  post: true,
};

export const CANDIDATES = ['.ai-review.yml', '.ai-review.yaml', 'ai-review.yml'];

const indentOf = (s: string) => s.length - s.trimStart().length;
const unquote = (s: string) => s.replace(/^["']|["']$/g, '');
const stripComment = (s: string) => s.replace(/\s+#.*$/, '').trim();
const splitInlineList = (v: string) =>
  v.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);

/** `source:line: detail`, or `source: detail` when the line is unknown. */
function configError(source: string, line: number | null, detail: string): Error {
  return new Error(`${line === null ? source : `${source}:${line}`}: ${detail}`);
}

/**
 * Read the indented `- item` lines that follow an empty `key:` at `keyIndent`.
 * Returns the items and the index of the first line outside the list. A nested mapping or an
 * empty item is a shape this parser cannot express, so it throws rather than dropping it.
 */
function readBlockList(
  lines: string[],
  start: number,
  keyIndent: number,
  key: string,
  source: string,
): { items: string[]; next: number } {
  const items: string[] = [];
  let j = start;
  for (; j < lines.length; j++) {
    const nextRaw = lines[j];
    const next = stripComment(nextRaw);
    if (!next || next.startsWith('#')) continue;
    if (indentOf(nextRaw) <= keyIndent) break;
    if (next !== '-' && !next.startsWith('- ')) {
      throw configError(
        source,
        j + 1,
        `key "${key}" has an indented nested mapping, which this flat parser cannot express; use "${key}: [a, b]" or an indented "- item" block list`,
      );
    }
    const item = unquote(next.slice(1).trim());
    if (!item) throw configError(source, j + 1, `key "${key}" has an empty list item`);
    items.push(item);
  }
  return { items, next: j };
}

/**
 * Flat key/value YAML (`key: value`, `key: [a, b]`, or a `key:` followed by an indented
 * `- item` block list). Enough for this config, so there is no parser dependency.
 *
 * Anything this parser cannot express throws instead of being silently dropped: a user who
 * writes a shape we do not support must see an error, not a config that quietly lost half
 * its keys.
 */
export function parseFlatYaml(src: string, source = '<config>'): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = stripComment(rawLine);
    if (!line || line.startsWith('#')) continue;

    // A `- item` with no key above it is always a mistake.
    if (line === '-' || line.startsWith('- ')) {
      throw configError(source, i + 1, `list item "${line}" has no parent key`);
    }

    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue.trim();

    if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = splitInlineList(value);
    } else if (value !== '') {
      out[key] = unquote(value);
    } else {
      // Empty value: a block sequence may follow at a deeper indent. A sibling at the same
      // indent ends the list and leaves the key genuinely empty.
      const { items, next } = readBlockList(lines, i + 1, indentOf(rawLine), key, source);
      if (items.length) {
        out[key] = items;
        i = next - 1;
      } else {
        out[key] = '';
      }
    }
  }
  return out;
}

export function loadConfig(root: string, overrides: Partial<Config> = {}): { config: Config; source: string | null } {
  let source: string | null = null;
  let parsed: Record<string, string | string[]> = {};
  for (const name of CANDIDATES) {
    const p = join(root, name);
    if (existsSync(p)) {
      parsed = parseFlatYaml(readFileSync(p, 'utf8'), name);
      source = name;
      break;
    }
  }
  const cfg: Config = { ...DEFAULTS };
  const num = (v: unknown) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  if (typeof parsed.model === 'string') cfg.model = parsed.model;
  if (typeof parsed.effort === 'string') cfg.effort = parsed.effort as Effort;
  if (typeof parsed.fail_on === 'string') cfg.fail_on = parsed.fail_on as FailOn;
  if (typeof parsed.language === 'string') cfg.language = parsed.language;
  if (typeof parsed.post === 'string') cfg.post = parsed.post === 'true';
  const mf = num(parsed.max_findings);
  if (mf !== undefined) cfg.max_findings = mf;
  const bc = num(parsed.budget_chars);
  if (bc !== undefined) cfg.budget_chars = bc;
  const mo = num(parsed.max_output_tokens);
  if (mo !== undefined) cfg.max_output_tokens = mo;
  if (Array.isArray(parsed.packs)) cfg.packs = parsed.packs;
  if (Array.isArray(parsed.ignore)) cfg.ignore = parsed.ignore;

  // env / flags win over the file
  if (process.env.AI_REVIEW_MODEL) cfg.model = process.env.AI_REVIEW_MODEL;
  if (process.env.AI_REVIEW_PACKS) cfg.packs = process.env.AI_REVIEW_PACKS.split(',').map((s) => s.trim());
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (cfg as any)[k] = v;
  }
  cfg.max_findings = Math.max(0, Math.min(50, Math.trunc(cfg.max_findings)));
  return { config: cfg, source };
}

/** Minimal glob: ** crosses directories, * does not. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') i++;
        re += '(?:.*/)?';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

export function ignored(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}
