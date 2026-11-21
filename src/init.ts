import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from './git.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, '..', 'templates');

function template(name: string, fallback: string): string {
  const p = join(TEMPLATES, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : fallback;
}

const CONFIG = `# ai-review configuration. Flat keys only.
model: deepseek-flash
# thinking effort: none | low | high | max   (low = fast, for pre-push; high = PRs)
effort: high
# never | critical | warning | any
fail_on: critical
max_findings: 8
# characters of repository context on top of the diff (~4 chars per token)
budget_chars: 60000
packs: [security, correctness]
ignore: ["**/*.md", "**/*.lock", "**/package-lock.json", "**/dist/**", "**/node_modules/**"]
post: true
`;

const HOOK_PRE_PUSH = (cmd: string) => `#!/bin/sh
# ai-review: full review of everything that differs from the base branch.
# Bypass once with: git push --no-verify
base=origin/HEAD
git rev-parse --verify --quiet "$base" >/dev/null 2>&1 || base=main
git rev-parse --verify --quiet "$base" >/dev/null 2>&1 || base=master
${cmd} review --base "$base" --fail-on critical --effort low --quiet
status=$?
if [ $status -eq 1 ]; then
  echo ""
  echo "ai-review blocked this push (critical findings above)."
  echo "Push anyway: git push --no-verify"
fi
exit $status
`;

const HOOK_PRE_COMMIT = (cmd: string) => `#!/bin/sh
# ai-review: zero-token secrets scan on staged lines only (<1s).
${cmd} review --staged --static-only --fail-on warning --quiet || {
  echo "ai-review found a credential in staged changes. Fix it or: git commit --no-verify"
  exit 1
}
`;

export function selfCommand(): string {
  const entry = process.argv[1] ?? 'ai-review';
  return entry.endsWith('.mjs') || entry.endsWith('.js') ? `node "${entry}"` : 'npx -y @dandrok/ai-review';
}

export function installHooks(opts: { preCommit: boolean; prePush: boolean }): string[] {
  const root = repoRoot();
  const hooksDir = join(root, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const cmd = selfCommand();
  const written: string[] = [];
  const write = (name: string, body: string) => {
    const p = join(hooksDir, name);
    if (existsSync(p) && !readFileSync(p, 'utf8').includes('ai-review')) {
      written.push(`${name}: left untouched (existing hook that is not ai-review's)`);
      return;
    }
    writeFileSync(p, body);
    chmodSync(p, 0o755);
    written.push(name);
  };
  if (opts.prePush) write('pre-push', HOOK_PRE_PUSH(cmd));
  if (opts.preCommit) write('pre-commit', HOOK_PRE_COMMIT(cmd));
  return written;
}

export function initProject(opts: { force: boolean; hooks: boolean; workflow: boolean }): string[] {
  const root = repoRoot();
  const log: string[] = [];
  const put = (rel: string, body: string) => {
    const p = join(root, rel);
    if (existsSync(p) && !opts.force) { log.push(`${rel} exists, skipped (use --force)`); return; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    log.push(`wrote ${rel}`);
  };
  put('.ai-review.yml', CONFIG);
  if (opts.workflow) put('.github/workflows/ai-review.yml', template('review.yml', ''));
  const gi = join(root, '.gitignore');
  if (existsSync(gi)) {
    const body = readFileSync(gi, 'utf8');
    if (!body.includes('.ai-review/')) {
      writeFileSync(gi, body + '\n# ai-review run artifacts\n.ai-review/\n');
      log.push('appended .ai-review/ to .gitignore');
    }
  }
  if (opts.hooks) log.push(...installHooks({ preCommit: false, prePush: true }).map((h) => `hook: ${h}`));
  return log;
}
