# ai-review

[![ci](https://github.com/dandrok/ai-review/actions/workflows/ci.yml/badge.svg)](https://github.com/dandrok/ai-review/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40dandrok%2Fai-review)](https://www.npmjs.com/package/@dandrok/ai-review)
[![runtime dependencies](https://img.shields.io/badge/runtime_deps-0-brightgreen)](#design-decisions-worth-knowing)
[![license](https://img.shields.io/npm/l/%40dandrok%2Fai-review)](LICENSE)

Diff-grounded AI code review for **any** git repository. One model call, findings anchored to real diff lines, inline PR comments, and a verdict computed in code — not by the model.

Not a CodeRabbit clone and not a platform. One bundled file, zero runtime dependencies, no server, no database, no index of your repo. The npm badge above is the only version this project keeps written down.

```
PR or local diff ──► cheap deterministic pass ──► context bundle ──► deepseek-flash (JSON)
                                                                        │
                    inline comments ◄── gate in code ◄── grounding ◄───┘
```

---

## Contents

1. [Quick start](#quick-start)
2. [How it works](#how-it-works)
3. [Context strategy](#context-strategy)
4. [What the comments look like](#what-the-comments-look-like)
5. [Commands](#commands)
6. [Configuration](#configuration)
7. [Cost](#cost)
8. [Any language, any repo](#any-language-any-repo)
9. [What it will not catch](#what-it-will-not-catch)
10. [Design decisions worth knowing](#design-decisions-worth-knowing)
11. [Releasing](#releasing)
12. [Roadmap](#roadmap)

---

## Quick start

Three lanes, same CLI. Pick by what the target project already has.

### A. JS / TS project (or any machine with Node 18+)

```bash
npx @dandrok/ai-review init          # writes .ai-review.yml, a GH workflow, and both git hooks
export DEEPSEEK_API_KEY=sk-...       # or add it to the repo's Actions secrets
npx @dandrok/ai-review review        # review the current branch vs the base branch
```

Every `npx @dandrok/ai-review …` below also works as a bare `ai-review …` once installed
globally. Global is the better choice for daily use: one stable command, no download per run.

```bash
npm i -g @dandrok/ai-review
ai-review review --worktree          # review your uncommitted work
```

### B. No Node at all

The tool is a bundle with zero runtime dependencies, so Docker is the whole story for
repos without Node:

```bash
docker build -t ai-review .
docker run --rm -v "$PWD:/repo" -w /repo -e DEEPSEEK_API_KEY ai-review review --worktree
```

Hooks are plain shell, so a Node-less repo wires one up once. The free, offline half
(secrets only, no model, no API key) is what belongs at commit time:

```sh
# .git/hooks/pre-commit
#!/bin/sh
exec docker run --rm -v "$PWD:/repo" -w /repo ai-review review --staged --static-only --quiet
```

Anything that can run a command can run this tool — the pipeline knows nothing about
JavaScript. See [Any language, any repo](#any-language-any-repo).

> **Why no `pre-commit` framework hook?** It was removed. `language: node` installs this
> package with `npm`, and npm runs a package's `prepare` script in a bare clone with **no
> dependencies installed**, so the build could never run. Supporting it would mean
> committing the compiled `dist/` back into git. `ai-review init` writes the same two
> hooks natively and needs nothing from the repo.

### C. GitHub Actions

`ai-review init` drops this into the repo; it needs no changes for a normal project:

```yaml
- uses: actions/checkout@v7
  with: { fetch-depth: 0 }          # the base branch must exist for the diff
- run: npx -y @dandrok/ai-review@latest review --base "origin/$BASE_REF" --post
  env:
    BASE_REF: ${{ github.base_ref }}   # never interpolate a ref into the script
    DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

[↑ Contents](#contents)

---

## How it works

| Step | What happens | Cost |
|---|---|---|
| 0 | `git diff` → parse hunks into an index of *new-side line numbers*. Secret patterns and committed credential files are caught here, on added lines only. | free, <1s |
| 1 | Context bundle under a character budget — see below. Stable content first, diff last. | free |
| 2 | **One** call to `deepseek-flash`, JSON output, all packs merged into one system prompt. | ~$0.002 |
| 3 | Grounding: any finding whose file is not in the diff, or whose lines touch no hunk, is dropped and logged. | free |
| 4 | Dedupe by file + category + overlapping lines, keep the highest severity, cap at `max_findings`. | free |
| 5 | Gate: count findings at or above `fail_on`. **The model's own `verdict` field is never used.** | free |
| 6 | Emit: one GitHub review with inline comments, terminal output, `--format json`/`markdown`, and `.ai-review/last.json`. | free |

Why each of those exists:

- **Grounding** is what makes an AI reviewer tolerable. A model that cites `src/auth.ts:412` for a file with 200 lines has produced noise, and one noisy comment costs more trust than ten missed bugs. Dropping ungrounded findings is cheaper and more honest than asking the model to try harder.
- **Step 0 before the model** is free correctness: a committed `.env` is a fact, not an opinion. It never needs an LLM.
- **One call, not four agents.** Four specialists multiply cost and latency by four and then need dedupe to hide the overlap. A single prompt that carries the security pack plus the correctness pack gets the same findings.
- **The gate in code** means a prompt-injected PR description cannot approve itself.

[↑ Contents](#contents)

---

## Context strategy

The question "how do we give it enough codebase context" is answered by *four cheap things and a budget*, not by indexing the repo.

| Priority | Block | Why it earns its tokens |
|---|---|---|
| 1 | `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` | project rules beat generic advice |
| 2 | Linked docs mentioned in the PR body (`docs/*.md`) | intent, and the only way "spec drift" findings can be real |
| 3 | Repo map: `path: exported symbols` | lets the model know what else exists without reading it |
| 4 | Full current text of each changed file (≤14k chars each) | the diff is a slice; the surrounding function is where the bug is |
| 5 | Literal-grep hits for the symbols the diff touches, outside the diff | catches caller/callee contract drift |

Total is capped by `budget_chars` (default 60,000 chars ≈ 15k tokens). When the budget runs out, the lowest-priority block is truncated or skipped and the decision is logged in `.ai-review/last.json`.

**Ordering is a cost decision, not an aesthetic one.** Blocks are emitted stable → volatile (rules, then docs, then map, then files, then callers, then the diff). DeepSeek bills cache hits at $0.003/M against $0.15/M for misses, and the cache matches on the prompt *prefix*. Putting the diff last means the system prompt plus repo map — the part that repeats on every run — is a cache hit. Put the diff first and you pay 50× on most of your input for nothing.

Nothing here uses an AST, an embedding, or a language server. See [Any language, any repo](#any-language-any-repo).

[↑ Contents](#contents)

---

## What the comments look like

One review, one inline comment per finding, anchored on a line that exists in the diff.
Inline comments are **flat** — nothing to expand, nothing to click, readable on arrival:

> 🔴 **Missing tenant scope on export** — `src/export.ts:5`
> _critical · security · security+correctness+performance_
>
> `where id = $1` has no `tenant_id` predicate, unlike `loadDoc` in `src/docs.ts`, so any authenticated user can export another tenant's document.
>
> **Fix:** Add `and tenant_id = $2` and pass the session tenant.
>
> `<!-- ai-review:v1 {"v":1,"id":"security-2-export.ts:5","rule":"security","severity":"CRITICAL","file":"src/export.ts","line":5} -->`

The **summary review** is the essay: a severity table, then **one** `<details>` that holds every finding
plus a single `text` fence restating the whole review as a batch instruction for an agent.
One expand and one copy block per review, not one per finding — a review with eight findings
should not be eight things to click.

GitHub sanitises HTML in comments, so there is no way to ship a real `<button>` — but **every
fenced code block gets a copy button in the top-right corner**, which is the same affordance with
no JavaScript and no extension. Paste that fence into Claude Code, Codex, Antigravity, anything,
and it has the file, the line, the reason and the intended fix for each finding.

The `<!-- ai-review:v1 … -->` comment stays invisible and is the machine-readable door for a
future `--fix` mode. `ai-review` itself never writes code.

The footer reports which packs ran, how many findings were dropped as ungrounded, the context and
diff character counts, the estimated cost, and the note that a human still merges.

[↑ Contents](#contents)

---

## Commands

```bash
ai-review review [options]        # the main command
ai-review init [--force] [--no-hooks] [--no-workflow]
ai-review install-hooks [--pre-commit] [--pre-push]
```

| Review flag | Meaning |
|---|---|
| `--staged` | staged changes only (pre-commit) |
| `--worktree` | uncommitted changes vs `HEAD` |
| `--base <ref>` | `<ref>...HEAD` (default: `origin/main`, `main`, `master`…) |
| `--commit <sha>` | a single commit |
| `--static-only` | no model call: secrets scan only, fast and free |
| `--dry-run` | print the context plan and stop |
| `--mock <file>` | replay a JSON review, no network (used by the test suite) |
| `--fail-on` | `never` \| `critical` \| `warning` \| `any` (default `critical`) |
| `--effort` | `none` \| `low` \| `high` \| `max` (default `high`; `low` for pre-push) |
| `--model <name>` | model id (default `deepseek-flash`) |
| `--packs` | `security,correctness,performance,spec` (default: the first three) |
| `--max-findings <n>` | cap after dedupe (default `8`, max `50`) |
| `--format` | `terminal` \| `json` \| `markdown` |
| `--quiet` / `-q` | suppress progress on stderr; findings still print |
| `--pr-title` / `--pr-body` | override the PR text when `--post` runs outside Actions |
| `--post` / `--no-post` | post as a GitHub PR review when CI env vars are present |

`--worktree` is the one to use when reviewing your own work before committing: it includes
staged **and** unstaged changes. `--staged` sees only what you added to the index, and the
default mode (no flag) sees only **commits** — so uncommitted edits look like "nothing to
review" there.

Exit codes: `0` clean (or below `fail_on`), `1` blockers found, `2` tool error. A pre-push hook uses the exit code; CI can use it as the job result. An **incomplete** review — the model hit `max_output_tokens` and returned no findings — is a `2`, never `0`: it did not complete, so it must not pass as clean.

Environment: `DEEPSEEK_API_KEY` (required), `AI_REVIEW_BASE_URL` (any OpenAI-compatible endpoint), `GITHUB_TOKEN` + `GITHUB_REPOSITORY` (auto-detected in Actions).

**The hooks `init` writes need the network today.** They call
`npx -y @dandrok/ai-review`, which resolves the `latest` version rather than the one you
installed. Offline, npm fails and the pre-commit hook still fails closed — but it reports
"found a credential" even when it never ran. Tracked as backlog #4; until then, `docker` or
a direct `node dist/ai-review.mjs` invocation avoids it.

### Where the key lives

The CLI looks for the key in this order, and a variable already exported in your shell always wins over every file — a committed `.env` can never shadow a CI secret:

| # | Location | Use |
|---|---|---|
| 1 | `./.env`, `./.env.local` in the repo being reviewed | per-project key, or a different model per repo |
| 2 | `$XDG_CONFIG_HOME/ai-review/env` or `~/.config/ai-review/env` | **one key for every repo** — the recommended setup |
| 3 | `~/.ai-review.env` | same thing, if you prefer it out of `~/.config` |
| 4 | `.env` next to the installed tool (`~/git/ai-review/.env`) | also gitignored, if you keep the tool in a fixed place |

The first file that defines a variable wins, so a repo's own `.env` always beats the global key.

So a single file makes the tool work from any directory:

```bash
mkdir -p ~/.config/ai-review && printf 'DEEPSEEK_API_KEY=sk-...\n' > ~/.config/ai-review/env && chmod 600 ~/.config/ai-review/env
```

The global file is outside every git repo, so there is nothing to leak — no `.gitignore` entry to remember, no `.env` to accidentally commit.

The key is never printed, logged, or written to `.ai-review/last.json`; the only thing reported is which *names* were loaded.

`.env` is ignored three ways, so an accidental `git add -A` cannot leak it:

| Where | What guards it |
|---|---|
| this repo | `.gitignore` — `.env`, `.env.*`, `!.env.example`, `*.pem`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*` |
| any repo that ran `ai-review init` | the same block is appended to that repo's `.gitignore` (idempotent, comments and all) |
| a repo without the block | the pre-model static pass flags a committed `.env` in the diff before any model call |

`.env.example` is deliberately **not** ignored — commit it with empty values.

[↑ Contents](#contents)

---

## Configuration

`.ai-review.yml` in the repo root. Flat keys only — no YAML dependency, so no supply-chain surface. Lists can be inline (`ignore: ["**/dist/**"]`) or a block list (`ignore:` then indented `- item` lines); both are equivalent. A shape this flat parser cannot express (for example a nested mapping) fails with an error naming the file and key rather than being silently dropped.

```yaml
model: deepseek-flash
effort: high          # none | low | high | max
fail_on: critical     # never | critical | warning | any
max_findings: 8
budget_chars: 60000
max_output_tokens: 16000   # output budget; thinking tokens are spent from it too
packs: [security, correctness, performance]
ignore: ["**/*.md", "**/*.lock", "**/dist/**"]
language: ""          # free-text stack hint for the prompt; "" = let the model infer
post: true
```

Packs are Markdown files that *are* the system prompt: `packs/security.md`, `packs/correctness.md`, `packs/performance.md`, `packs/spec.md`. To add a house rule, drop `.ai-review/packs/house.md` in the target repo — it overrides the bundled pack of the same name. No code change, no rebuild. **Commit it**: `.gitignore` only excludes `.ai-review/last.json`, so a pack override travels with the repo and the CI run sees it too. Repos initialised by 0.2.1 or earlier still ignore the whole directory — re-run `ai-review init` once to narrow it.

[↑ Contents](#contents)

---

## Cost

Rates are DeepSeek's, and DeepSeek's pricing page is the only source of truth:
<https://api-docs.deepseek.com/quick_start/pricing>

`src/llm.ts` keeps a small table so the summary can print an estimate. Treat that number as
an estimate, not a bill: it is a hardcoded copy of a public price list, so it is wrong the
moment DeepSeek changes one, and it knows nothing about discounts your account actually has.

What actually determines cost is the shape of one review, not the number of files:

- **one** prompt: the diff plus a context bundle capped by `budget_chars` (default 60k chars ≈ 15k tokens);
- most of that prompt is a stable prefix — system prompt and repo map — which bills at the cached rate;
- output is capped by `max_output_tokens` (default 16k) and in practice is a few hundred tokens of JSON.

That is why prompt ordering is a cost decision and not an aesthetic one — see
[Context strategy](#context-strategy). At current rates a review is comfortably under a cent,
which is the reason the only thing worth optimising here is the cache-hit rate.

[↑ Contents](#contents)

---

## Any language, any repo

Nothing in the pipeline knows what language the target is written in:

- the diff is text from `git`;
- the repo map is `git ls-files` plus a regex over `export|function|class|def|fn|func` — good enough for JS/TS, Python, Go, Rust, PHP, Ruby, Java, Swift, Vue, Svelte;
- caller lookup is a literal `git grep`, which is language-agnostic by construction;
- the packs are prose instructions, not fenced rules.

`language:` in the config is a one-line hint for the prompt (`The repository is written in Go`), not an input to any parser. A Go, Python or Rust repo gets the same pipeline; only the packs' examples read strangely.

**Why TypeScript and not shell:** the tool has to parse unified diffs into line indices, validate model output, retry on invalid JSON, and assemble a GitHub review payload. In bash that is a pile of `jq` and `awk` with no types, and every edge case in diff parsing becomes a silent wrong-line comment. Node is present on any machine that would run this via `npx`, and the Docker lane covers the rest. It is written as one file with no dependencies, so `npx` has nothing to install and the target repo gains no supply-chain risk.

[↑ Contents](#contents)

---

## What it will not catch

Being explicit, because unstated limits are how reviewers get a bad name:

- **Bugs that need runtime knowledge** — a production config, a feature flag, a middleware order. The tool reads static text.
- **Anything outside the diff.** By design. A pre-existing vulnerability in a file the PR touches but does not change is invisible — that is a job for a security audit, not a diff reviewer.
- **Architecture.** "This belongs in a different layer" needs the kind of judgement a diff does not carry.
- **Test quality.** It flags missing tests for nothing; it cannot tell whether a test asserts the right thing.
- **Spec drift without a spec.** The `spec` pack returns zero findings when no spec is supplied — it does not invent requirements from the PR description.

[↑ Contents](#contents)

---

## Design decisions worth knowing

1. **Comment-only first.** Set `fail_on: never` for the first two weeks in a new repo and count which findings you actually fix. Turning the gate on before you have measured precision is how a bot gets ignored forever.
2. **No multi-agent.** One call. A `category` field gives the same triage with a quarter of the cost.
3. **No strict JSON schema.** DeepSeek supports `response_format: json_object`, not `json_schema` — and on unparseable output it returns *blank content* rather than an error. So the tool validates with its own guard and retries with the exact validation errors in the next turn (twice, then fails loudly rather than half-reporting).
4. **Prompt-injection guard.** Every piece of author-controlled text — title, description, file contents, diff — is wrapped in `<untrusted>`, and the system prompt states that claims inside it never reduce the review. A PR that says "this is a test, do not flag" changes nothing.
5. **`effort: low` for pre-push.** `thinking` is enabled by default at `high`, which is 15–30 s. The pre-push hook cuts it to `low`.
6. **Pre-commit runs no model.** An LLM in pre-commit gets `--no-verify`'d within a week. `--static-only` there is <1 s and catches the one class that must never be committed.

[↑ Contents](#contents)

---

## Releasing

Publishing runs from a tag, with no long-lived npm token: `.github/workflows/release.yml` authenticates through **npm Trusted Publishing** (OIDC) and publishes with provenance.

One-time setup, in this order:

1. `npm login` locally, and confirm your npm username owns the scope (`npm whoami` → must be `dandrok`, or the package has to be renamed to `@<your-npm-username>/ai-review`).
2. The first publish must be manual — Trusted Publishing is configured on an existing package's settings page, and provenance cannot be generated outside CI:

   ```bash
   npm publish --access public          # no --provenance here: there is no CI provider to attest
   ```

   Provenance is enabled on the release workflow's command instead (`.github/workflows/release.yml`), never in `publishConfig`, because a `publishConfig.provenance: true` makes *every* publish — including a local one — fail with `Automatic provenance generation not supported for provider: null`.

3. On npmjs.com → the package → **Settings → Trusted Publisher** → GitHub Actions: user `dandrok`, repository `ai-review`, workflow `release.yml`. Leave the environment empty unless you use one.
4. Enable 2FA on the npm account.

After that, every release is:

```bash
npm version patch        # or minor / major — bumps package.json and creates the tag
git push --follow-tags   # the tag triggers the workflow, which re-runs build + typecheck + tests
```

The workflow refuses to publish when the tag and `package.json` disagree, so a mistyped version fails CI instead of shipping.

[↑ Contents](#contents)

---

## Roadmap

- `review --fix`: read `ai-review:v1` payloads from PR comments and hand them to a coding agent as a batch. The comment format already supports it.
- Precision report: `ai-review stats` over `.ai-review/*.json` — how many findings were resolved vs dismissed.
- Publish as a GitHub Action (marketplace listing) for repos that prefer `uses:` over `npx`.
- Optional second pass that only re-reads CRITICAL findings with a bigger model, for repos where the gate blocks merges.

[↑ Contents](#contents)

---

MIT. Built for a talk I saw at GDG DevFest Warsaw 2026; the architecture owes a debt to [burnjohn/ai-code-reviewer-workshop](https://github.com/burnjohn/ai-code-reviewer-workshop) and shrinks it deliberately: one model call, two packs, no UI.
