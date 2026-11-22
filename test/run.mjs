import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDiff, numberedDiff, groundFindings, countBlockers, validateReview,
  dedupFindings, staticFindings, globToRegExp, estimateCost, loadDotEnv, ensureGitignore,
  toReviewPayload,
  loadDotEnvFiles, globalKeyFiles,
} from '../dist/lib.mjs';

const DIFF = `diff --git a/src/export.ts b/src/export.ts
index 1111111..2222222 100644
--- a/src/export.ts
+++ b/src/export.ts
@@ -10,6 +10,8 @@ export async function exportDoc(id) {
 const rows = await db.query('select * from docs where id = $1', [id]);
+  const name = 'access_token';
+  return rows.rows;
 }
diff --git a/src/legacy.ts b/src/legacy.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/legacy.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const a = 1;
-const b = 2;
`;

test('parseDiff: hunk line numbers, added and deleted files', () => {
  const d = parseDiff(DIFF);
  assert.equal(d.files.length, 2);
  assert.equal(d.files[0].path, 'src/export.ts');
  assert.equal(d.files[0].isDeleted, false);
  assert.deepEqual([...d.files[0].hunks[0].newLineNumbers], [10, 11, 12, 13]);
  assert.equal(d.files[1].isDeleted, true);
});

test('numberedDiff: prefixes new-side numbers only', () => {
  const text = numberedDiff(parseDiff(DIFF));
  assert.match(text, /\+   12\|/);
  assert.match(text, /### src\/legacy\.ts \(deleted file\)/);
});

test('grounding: drops off-diff, keeps real ranges', () => {
  const d = parseDiff(DIFF);
  const base = { end_line: 12, category: 'security', title: 'x', rationale: 'y', suggestion: '' };
  const { kept, dropped } = groundFindings(
    [
      { ...base, file: 'src/export.ts', start_line: 12, severity: 'CRITICAL' },
      { ...base, file: 'src/export.ts', start_line: 400, end_line: 400, severity: 'CRITICAL' },
      { ...base, file: 'src/nope.ts', start_line: 1, severity: 'CRITICAL' },
    ],
    d,
  );
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 2);
  assert.match(dropped[0].reason, /touch no hunk/);
  assert.match(dropped[1].reason, /not in the diff/);
});

test('gate: severities decide, not the model verdict', () => {
  const f = (severity) => ({ file: 'a', start_line: 1, end_line: 1, severity, category: 'security', title: '', rationale: '', suggestion: '' });
  const findings = [f('SUGGESTION'), f('WARNING'), f('CRITICAL')];
  assert.equal(countBlockers(findings, 'critical'), 1);
  assert.equal(countBlockers(findings, 'warning'), 2);
  assert.equal(countBlockers(findings, 'any'), 3);
  assert.equal(countBlockers(findings, 'never'), 0);
});

test('validateReview: rejects bad enums, accepts a clean review', () => {
  const bad = validateReview({ summary: 's', verdict: 'lgtm', findings: [{ file: 'a.ts', start_line: 1, severity: 'HIGH', category: 'bugs', title: 't', rationale: 'r' }] });
  assert.equal(bad.review, null);
  assert.equal(bad.errors.length, 3);
  const good = validateReview({ summary: 's', verdict: 'comment', findings: [{ file: './a.ts', start_line: 3, end_line: 2, severity: 'warning', category: 'security', title: 't', rationale: 'r' }] });
  assert.ok(good.review);
  assert.equal(good.review.findings[0].file, 'a.ts');
  assert.equal(good.review.findings[0].end_line, 3);
});

test('dedup: same spot collapses to the highest severity', () => {
  const f = (severity, title, line) => ({ file: 'a.ts', start_line: line, end_line: line, severity, category: 'security', title, rationale: 'r', suggestion: '' });
  const out = dedupFindings([f('SUGGESTION', 'Missing tenant scope in export query', 12), f('CRITICAL', 'Missing tenant scope in export query!', 12), f('WARNING', 'Other issue here that is long enough', 40)]);
  assert.equal(out.length, 2);
  assert.equal(out[0].severity, 'CRITICAL');
});

const SYNTHETIC_KEY = 'AKIA' + 'Z7XK2QM4N8P1RTUV'; // 20 chars, not a real credential

test('static: catches a committed AWS key, ignores placeholders', () => {
  const diff = parseDiff(`diff --git a/c.ts b/c.ts
--- a/c.ts
+++ b/c.ts
@@ -1,1 +1,3 @@
 const a = 1;
+const key = '${SYNTHETIC_KEY}';
+const fake = 'api_key: "your_key_placeholder"';
`);
  const found = staticFindings(diff);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'CRITICAL');
  assert.equal(found[0].start_line, 2);
});

test('static: flags a committed .env', () => {
  const diff = parseDiff(`diff --git a/.env b/.env
new file mode 100644
--- /dev/null
+++ b/.env
@@ -0,0 +1,1 @@
+FOO=bar
`);
  assert.equal(staticFindings(diff)[0].title.includes('.env'), true);
});

test('config: glob semantics', () => {
  assert.ok(globToRegExp('**/*.md').test('docs/a.md'));
  assert.ok(globToRegExp('**/*.md').test('a.md'));
  assert.ok(!globToRegExp('**/*.md').test('a.mdx'));
  assert.ok(globToRegExp('src/*.ts').test('src/a.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/x/a.ts'));
});

test('cost: cache hits dominate', () => {
  const hit = estimateCost('deepseek-flash', { prompt_tokens: 20000, completion_tokens: 1000, cache_hit_tokens: 18000, cache_miss_tokens: 2000 }, new Date('2026-11-21T22:00:00Z'));
  assert.ok(hit > 0 && hit < 0.005, `expected < $0.005, got ${hit}`);
});
test('env: .env loads, quotes and comments handled, real environment wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-review-env-'));
  writeFileSync(
    join(dir, '.env'),
    '# comment line\nexport FOO_A=from-file\nFOO_B="quoted value"\nFOO_C=bare # trailing comment\nDEEPSEEK_API_KEY=from-file\n',
  );
  process.env.DEEPSEEK_API_KEY = 'from-shell';
  const res = loadDotEnv([dir]);
  assert.equal(process.env.FOO_A, 'from-file');
  assert.equal(process.env.FOO_B, 'quoted value');
  assert.equal(process.env.FOO_C, 'bare');
  assert.equal(process.env.DEEPSEEK_API_KEY, 'from-shell', 'a shell variable must never be overridden by .env');
  assert.deepEqual([...res.vars].sort(), ['FOO_A', 'FOO_B', 'FOO_C']);
  assert.equal(res.files.length, 1);
  delete process.env.FOO_A; delete process.env.FOO_B; delete process.env.FOO_C;
});

test('gitignore: creates the secrets block once, then leaves it alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-review-gi-'));
  const first = ensureGitignore(dir);
  const text = readFileSync(join(dir, '.gitignore'), 'utf8');
  for (const pattern of ['.env', '.env.*', '!.env.example', '*.pem', 'id_rsa*', '.ai-review/last.json']) {
    assert.ok(text.split('\n').includes(pattern), `missing ${pattern}`);
  }
  assert.match(first[0], /created/);
  const second = ensureGitignore(dir);
  assert.match(second[0], /already covers/);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), text);
});
test('env: one global key file serves every repo', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-review-home-'));
  // CI runners export XDG_CONFIG_HOME; an explicit home must still win.
  process.env.XDG_CONFIG_HOME = '/tmp/not-this-home';
  mkdirSync(join(home, '.config', 'ai-review'), { recursive: true });
  writeFileSync(join(home, '.config', 'ai-review', 'env'), 'AI_REVIEW_GLOBAL_KEY=from-global\n');
  const paths = globalKeyFiles(home);
  assert.equal(paths.length, 2);
  assert.equal(paths[0], join(home, '.config', 'ai-review', 'env'));
  const res = loadDotEnvFiles(paths);
  assert.equal(process.env.AI_REVIEW_GLOBAL_KEY, 'from-global');
  assert.equal(res.files.length, 1);
  // an explicit XDG root is still honoured when passed
  assert.equal(globalKeyFiles(home, '/tmp/xdg-root')[0], '/tmp/xdg-root/ai-review/env');
  delete process.env.XDG_CONFIG_HOME;
});
test('output: inline comments are flat, the summary has one expand with one copy block', () => {
  const diff = parseDiff(`diff --git a/src/db.ts b/src/db.ts
--- a/src/db.ts
+++ b/src/db.ts
@@ -1,1 +1,2 @@
 const q = 1;
+  const rows = await query('select * from docs where id = $1', [id]);
`);
  const mk = (line, sev) => ({
    file: 'src/db.ts', start_line: line, end_line: line, severity: sev, category: 'security',
    title: `Missing <tenant> scope ${line}`, rationale: 'No tenant_id predicate, unlike loadDoc.',
    suggestion: 'Add `and tenant_id = $2`.', id: `security-${line}-db.ts:${line}`,
  });
  const payload = toReviewPayload({
    findings: [mk(2, 'CRITICAL'), mk(3, 'WARNING')], droppedCount: 1, diff, agent: 'security+correctness',
    failOn: 'critical', summary: 's', model: 'm', costUsd: 0.001, gate: true, contextChars: 0, diffChars: 0,
  });

  // inline comments: nothing to expand, nothing to click
  for (const c of payload.comments) {
    assert.ok(!c.body.includes('<details>'), 'inline comment must not nest an expand');
    assert.ok(!c.body.includes('```'), 'no copy fence per finding: copying is a whole-review action');
    assert.match(c.body, /<!-- ai-review:v1 /);
  }

  // summary: exactly one expand, one fence, containing every finding
  assert.equal((payload.body.match(/<details>/g) || []).length, 1);
  assert.equal((payload.body.match(/<\/details>/g) || []).length, 1);
  assert.match(payload.body, /All 2 finding\(s\)/);
  assert.equal((payload.body.match(/```text/g) || []).length, 1, 'one copy block for the whole review');
  const prompt = payload.body.slice(payload.body.indexOf('```text'));
  assert.match(prompt, /id: security-2-db\.ts:2/);
  assert.match(prompt, /id: security-3-db\.ts:3/);
  assert.match(prompt, /SKIPPED/);
  assert.match(prompt, /Findings \(2\)/);
  assert.match(payload.body, /Missing &lt;tenant&gt; scope 2/);
});

test('git: mnemonic prefixes and quoted paths cannot silently drop findings', () => {
  // Both settings make git print a header the parser cannot read: `c/x w/x` from
  // diff.mnemonicPrefix, and `"a/caf\303\251.txt"` from core.quotePath (true by default).
  // Either one used to make every finding vanish as "not in the diff" — reported as a clean
  // review with exit 0, which is the one failure mode this tool must never have.
  const repo = mkdtempSync(join(tmpdir(), 'ai-review-git-'));
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.test']);
  git(['config', 'user.name', 'test']);
  git(['config', 'diff.mnemonicPrefix', 'true']);
  git(['config', 'core.quotePath', 'true']);
  writeFileSync(join(repo, 'café.txt'), `const key = 'AKIA${'Z7XK2QM4N8P1RTUV'}';\n`);
  git(['add', '.']);

  const cli = fileURLToPath(new URL('../dist/ai-review.mjs', import.meta.url));
  const r = spawnSync(
    process.execPath,
    [cli, 'review', '--staged', '--static-only', '--format', 'json', '--fail-on', 'never'],
    { cwd: repo, encoding: 'utf8' },
  );
  const findings = JSON.parse(r.stdout).findings;
  assert.equal(findings.length, 1, `expected the key to be reported; got ${r.stdout}${r.stderr}`);
  assert.equal(findings[0].file, 'café.txt');
});

test('git: a failed diff is a tool error, not an empty review', () => {
  // sh() used to return '' on any git error. '' parses to zero files, which run.ts reports as
  // "nothing to review" with exit 0 — so a typo'd --base was a green run.
  const repo = mkdtempSync(join(tmpdir(), 'ai-review-badbase-'));
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.test']);
  git(['config', 'user.name', 'test']);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);

  const cli = fileURLToPath(new URL('../dist/ai-review.mjs', import.meta.url));
  const r = spawnSync(
    process.execPath,
    [cli, 'review', '--base', 'no-such-ref', '--format', 'json'],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(r.status, 2, `bad --base must exit 2; got ${r.status}: ${r.stderr}`);
  assert.equal(r.stdout.trim(), '', 'must not print a review for a diff it could not read');
});

test('git: one unreadable header fails the run instead of losing one file', { skip: process.platform === 'win32' }, () => {
  // git still quotes a filename containing a double quote, even with core.quotePath=false, so
  // that header cannot be parsed. Checking only that *some* header matched let a clean file in
  // the same diff mask it, and the quoted file's findings were lost. (Windows forbids `"` in
  // filenames, hence the skip.)
  const repo = mkdtempSync(join(tmpdir(), 'ai-review-badheader-'));
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.test']);
  git(['config', 'user.name', 'test']);
  writeFileSync(join(repo, 'normal.txt'), 'y\n');
  writeFileSync(join(repo, 'we"ird.txt'), 'z\n');
  git(['add', '.']);

  const cli = fileURLToPath(new URL('../dist/ai-review.mjs', import.meta.url));
  const r = spawnSync(
    process.execPath,
    [cli, 'review', '--staged', '--static-only', '--format', 'json'],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(r.status, 2, `unreadable header must exit 2; got ${r.status}`);
  assert.match(r.stderr, /unreadable diff header/);
});
