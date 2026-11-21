import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDiff, numberedDiff, groundFindings, countBlockers, validateReview,
  dedupFindings, staticFindings, globToRegExp, estimateCost, loadDotEnv, ensureGitignore,
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
  for (const pattern of ['.env', '.env.*', '!.env.example', '*.pem', 'id_rsa*', '.ai-review/']) {
    assert.ok(text.split('\n').includes(pattern), `missing ${pattern}`);
  }
  assert.match(first[0], /created/);
  const second = ensureGitignore(dir);
  assert.match(second[0], /already covers/);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), text);
});
