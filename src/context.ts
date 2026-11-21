import { readRepoFile, repoMap, grepSymbols, listFiles } from './git.ts';
import { wrapUntrusted } from './prompt.ts';
import type { UnifiedDiff } from './diff.ts';

const MAX_FILE_CHARS = 14_000;
const MAX_DOC_CHARS = 8_000;
const MIN_USEFUL = 400;

export interface ContextResult {
  blocks: string[];
  log: string[];
  chars: number;
}

interface Candidate {
  kind: 'rules' | 'spec' | 'map' | 'file' | 'callers';
  label: string;
  text: string;
  maxChars: number;
}

const RULES = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md'];

function linkedDocs(body: string, existing: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/([A-Za-z0-9_.\-/]+\.md)/g)) {
    let p = m[1].replace(/^\.\//, '');
    if (p.includes('://') || p.startsWith('..')) continue;
    if (!existing.has(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= 4) break;
  }
  return out;
}

/** Symbols the diff touches, used to find callers outside the diff. */
export function touchedSymbols(diff: UnifiedDiff): string[] {
  const names = new Set<string>();
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/,
    /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /(?:^|\s)def\s+([A-Za-z_]\w*)/,
    /(?:^|\s)fn\s+([A-Za-z_]\w*)/,
    /(?:^|\s)func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  ];
  for (const file of diff.files) {
    if (file.isNew) continue;
    for (const hunk of file.hunks) {
      // The text after the second @@ is the enclosing function/class.
      const enclosing = /@@.*@@\s*(.+)$/.exec(hunk.header);
      if (enclosing) {
        const m = /([A-Za-z_$][\w$]{3,})/.exec(enclosing[1]);
        if (m) names.add(m[1]);
      }
      for (const line of hunk.lines) {
        if (line.kind === '-') continue;
        for (const re of patterns) {
          const m = re.exec(line.text);
          if (m) { names.add(m[1]); break; }
        }
      }
    }
  }
  const stop = new Set(['default', 'handler', 'render', 'constructor', 'returnv', 'then', 'catch']);
  return [...names].filter((n) => n.length >= 4 && !stop.has(n)).slice(0, 10);
}

/**
 * Context under a character budget, ordered stable → volatile so the model's
 * prefix cache covers as much of the prompt as possible.
 */
export function buildContext(opts: {
  root: string;
  diff: UnifiedDiff;
  prBody: string;
  budget: number;
}): ContextResult {
  const { diff, budget } = opts;
  const changed = new Set(diff.files.map((f) => f.path));
  const all = listFiles();
  const allSet = new Set(all);
  const candidates: Candidate[] = [];
  const log: string[] = [];

  for (const name of RULES) {
    if (!allSet.has(name)) continue;
    const text = readRepoFile(opts.root, name);
    if (text) candidates.push({ kind: 'rules', label: name, text, maxChars: 6_000 });
  }
  for (const doc of linkedDocs(opts.prBody, allSet)) {
    const text = readRepoFile(opts.root, doc);
    if (text) candidates.push({ kind: 'spec', label: doc, text, maxChars: MAX_DOC_CHARS });
  }
  const map = repoMap(opts.root, all);
  if (map) candidates.push({ kind: 'map', label: 'repo-map', text: map, maxChars: 4_000 });

  const ordered = [...diff.files].sort((a, b) => b.hunks.length - a.hunks.length);
  for (const file of ordered) {
    if (file.isDeleted || !file.hunks.length) continue;
    const text = readRepoFile(opts.root, file.path);
    if (!text) continue;
    candidates.push({ kind: 'file', label: file.path, text, maxChars: MAX_FILE_CHARS });
  }

  const symbols = touchedSymbols(diff);
  if (symbols.length) {
    const { text, hits } = grepSymbols(symbols, changed, 20);
    if (hits) candidates.push({ kind: 'callers', label: `usages of ${symbols.join(', ')}`, text, maxChars: 6_000 });
  }

  const HEADING: Record<Candidate['kind'], string> = {
    rules: 'Project rules',
    spec: 'Specification / linked doc',
    map: 'Repository map (paths → exported symbols)',
    file: 'Full current file (the diff above is only a slice of it)',
    callers: 'Usages outside the diff',
  };

  const blocks: string[] = [];
  let used = 0;
  for (const c of candidates) {
    const room = Math.min(c.maxChars, budget - used);
    if (room < MIN_USEFUL) { log.push(`${c.kind} ${c.label}: skipped (budget exhausted)`); continue; }
    const clipped = c.text.length > room ? c.text.slice(0, room) + '\n[… truncated]' : c.text;
    blocks.push(`### ${HEADING[c.kind]} — ${c.label}\n${wrapUntrusted(c.label, clipped)}`);
    used += clipped.length;
    log.push(`${c.kind} ${c.label}: ${clipped.length} chars${clipped.length < c.text.length ? ' (truncated)' : ''}`);
    if (used >= budget) break;
  }
  return { blocks, log, chars: used };
}
