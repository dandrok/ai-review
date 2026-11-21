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

/** Flat key/value YAML only (`key: value`, `key: [a, b]`). Enough for this config, no parser dependency. */
export function parseFlatYaml(src: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const rawLine of src.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    const v = value.trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      out[key] = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      out[key] = v.replace(/^["']|["']$/g, '');
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
      parsed = parseFlatYaml(readFileSync(p, 'utf8'));
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
