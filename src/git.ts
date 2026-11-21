import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function sh(args: string[], allowFail = false): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    if (allowFail) return '';
    const err = String(e?.stderr ?? e?.message ?? e);
    throw new Error(`git ${args.join(' ')} failed: ${err.trim()}`);
  }
}

export function repoRoot(): string {
  return sh(['rev-parse', '--show-toplevel']).trim();
}

export function isRepo(): boolean {
  return sh(['rev-parse', '--is-inside-work-tree'], true).trim() === 'true';
}

/** Pick a base ref to diff against: explicit flag, then the usual suspects. */
export function defaultBase(): string | null {
  for (const ref of ['origin/main', 'origin/master', 'origin/develop', 'main', 'master', 'develop']) {
    if (sh(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true).trim()) return ref;
  }
  return null;
}

export type DiffMode = 'staged' | 'worktree' | 'range' | 'commit';

export function diffFor(mode: DiffMode, base?: string | null): { raw: string; label: string } {
  const common = ['--no-color', '--no-ext-diff', '--unified=3'];
  if (mode === 'staged') {
    return { raw: sh(['diff', '--staged', ...common], true), label: 'staged changes' };
  }
  if (mode === 'worktree') {
    return { raw: sh(['diff', 'HEAD', ...common], true), label: 'uncommitted changes vs HEAD' };
  }
  if (mode === 'commit') {
    const ref = base || 'HEAD';
    return { raw: sh(['show', '--format=', ...common, ref], true), label: `commit ${ref}` };
  }
  const from = base || defaultBase();
  if (!from) {
    // First commit on a branch with no remote: diff the whole tree against nothing.
    return { raw: sh(['diff', EMPTY_TREE, 'HEAD', ...common], true), label: 'full tree (no base ref found)' };
  }
  return { raw: sh(['diff', `${from}...HEAD`, ...common], true), label: `range ${from}...HEAD` };
}

/** Current file contents on disk (what a pre-push hook would review). */
export function readRepoFile(root: string, path: string, maxBytes = 400_000): string | null {
  const abs = join(root, path);
  if (existsSync(abs)) {
    try {
      const buf = readFileSync(abs);
      return buf.length > maxBytes ? buf.subarray(0, maxBytes).toString('utf8') : buf.toString('utf8');
    } catch {
      return null;
    }
  }
  const fromGit = sh(['show', `HEAD:${path}`], true);
  return fromGit || null;
}

export function listFiles(): string[] {
  const out = sh(['ls-files'], true);
  return out.split('\n').filter(Boolean);
}

/** Literal (fixed-string) search for symbol usages outside the changed files. */
export function grepSymbols(names: string[], excludePaths: Set<string>, maxHits = 24): { text: string; hits: number } {
  const needles = names.filter((n) => n.length >= 4).slice(0, 12);
  if (!needles.length) return { text: '', hits: 0 };
  const args = ['grep', '-n', '-F', '--no-color', '--'];
  for (const n of needles) args.push('-e', n);
  // Files come back as path:line:content
  const out = sh(args, true);
  if (!out) return { text: '', hits: 0 };
  const kept: string[] = [];
  let hits = 0;
  for (const line of out.split('\n')) {
    if (!line) continue;
    const path = line.slice(0, line.indexOf(':'));
    if (excludePaths.has(path)) continue;
    if (/(^|\/)(node_modules|dist|build|vendor|\.next|coverage)\//.test(path)) continue;
    if (/(\.min\.|\.lock$|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)/.test(path)) continue;
    kept.push(line.slice(0, 300));
    if (++hits >= maxHits) break;
  }
  return { text: kept.join('\n'), hits };
}

const NAME_PATTERNS = [
  /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*def\s+([A-Za-z_]\w*)/,
  /^\s*class\s+([A-Za-z_]\w*)/,
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
];

/** Cheap repo map: paths + the names each file exports. No AST, no index. */
export function repoMap(root: string, files: string[], maxChars = 3500): string {
  const skip = /(^|\/)(node_modules|dist|build|vendor|\.git|\.next|coverage|fixtures?|__snapshots__)\//;
  const ext = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|php|java|kt|swift|vue|svelte)$/;
  const lines: string[] = [];
  let used = 0;
  for (const f of files) {
    if (skip.test(f) || !ext.test(f)) continue;
    const body = readRepoFile(root, f, 16_000);
    if (!body) continue;
    const names: string[] = [];
    for (const line of body.split('\n')) {
      if (line.length > 300) continue;
      for (const re of NAME_PATTERNS) {
        const m = re.exec(line);
        if (m) { names.push(m[1]); break; }
      }
      if (names.length >= 8) break;
    }
    if (!names.length) continue;
    const row = `${f}: ${names.join(', ')}`;
    if (used + row.length > maxChars) { lines.push('… (repo map truncated)'); break; }
    lines.push(row);
    used += row.length + 1;
  }
  return lines.join('\n');
}
