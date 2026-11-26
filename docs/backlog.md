# Backlog

Known gaps, in rough priority order. Each entry says what is wrong, how it was
observed, and what "done" looks like — so a later session does not have to
rediscover the reasoning.

---

## 1. `init` ignores `core.hooksPath`

**Status:** bug, proven.
**Evidence:** libretto sets `core.hooksPath = .githooks`. `ai-review init` wrote
`.git/hooks/pre-push`, which git never executes in that repo — the hook was silently
dead until it was copied to `.githooks/pre-push` by hand.
**Done:** `installHooks()` reads `git config --get core.hooksPath` first and writes
there; the log line names the directory it used. If the directory is tracked, say so
(the hook becomes part of the repo, which is the better outcome).

## 2. `init` should finish the job

**Status:** partially exists — `init` already writes `.ai-review.yml`,
`.github/workflows/ai-review.yml` (unless `--no-workflow`), the `.gitignore` block and
the hook. What it does not do:

- `init --secret` — when `gh` is authenticated, run
  `gh secret set DEEPSEEK_API_KEY` (reads the value from `~/.config/ai-review/env`);
  otherwise print the exact UI path plus the command. The secret is the only step that
  cannot be done by writing a file.
- `init --commit` — `git add` the three files and commit with a conventional message,
  so a new repo is done in one command.
- `init --dry-run` — print what would be written.

**Done:** `npx @dandrok/ai-review init` on an empty repo leaves one uncommitted commit
and one missing secret, and prints exactly what to do about the secret.

## 3. README drift

**Status:** open.
**Known:** `core.hooksPath` behaviour is undocumented. `--static-only` does not write
`.ai-review/last.json` (only a full run does) and that is not stated.
**Done:** every config key in `src/config.ts` appears in the README config block, and
each CLI behaviour that writes or does not write an artifact is stated once.

## 4. Secrets gate depends on npm

**Status:** open, design decision needed.
**Evidence:** the pre-push hook shells out to `npx`. When npm is unreachable it prints
"could not run — not blocking" and exits 0, so the gate silently no-ops in exactly the
case it exists for. Two review rounds flagged this from opposite directions.
**Decision:** deterministic gates fail **closed**; judgements never block. So the fix is
not to block on `npx` failing, it is to remove the dependency: a `git diff | grep -E`
fallback (AKIA, BEGIN PRIVATE KEY, ghp_, sk-) that always runs, with the tool's patterns
as an optional upgrade.
**Done:** the hook blocks on a key match with no network and no npm.

## 5. Pre-push scans `HEAD`, not the pushed refs

**Status:** open.
**Evidence:** the hook runs `review --base origin/main`, i.e. `HEAD`. The pre-push
protocol hands the local and remote SHAs of each pushed ref on stdin; `git push origin
otherbranch` while checked out elsewhere scans the wrong tree.
**Done:** parse stdin, scan the pushed range (or one scan per ref), and skip when every
line is a delete.

## 6. Accepted-risk memory

**Status:** open, highest value for signal-to-noise.
**Evidence:** the tool is stateless, so a decision that was made and accepted is
re-derived every run. `@latest` was raised as a finding three rounds in a row after
being consciously accepted.
**Done:** `.ai-review/accept.yml` listing finding ids with a one-line reason, filtered
before posting, and named in the summary ("2 accepted, not shown").

## 7. One review per push

**Status:** open.
**Evidence:** libretto PR #63: 8 pushes produced 8 reviews and 22 inline comments on a
3-file diff, most of them outdated after the next push.
**Done:** either one sticky summary comment updated in place per push, or skip findings
whose id was already commented on the PR. Inline comments only for findings that are new
since the last review.

## 8. Ship `fail_on: never` as the default

**Status:** open, follows from decisions #1 and #7.
**Evidence:** `DEFAULTS.fail_on` and the config `init` writes both say `critical`, while
every adopted repo ends up setting `never` by hand.
**Done:** the generated config defaults to `never` with a comment explaining what would
justify turning it on.

## 9. Packs as a portable agent skill

**Status:** open, follows from decision #6.
**Evidence:** the packs are the only non-replaceable part, and they are currently only
reachable through this CLI.
**Done:** a `skill/` bundle (SKILL.md + the four packs) that Claude Code / Codex /
Antigravity can load directly, generated from `packs/` so there is one source of truth.

## 10. Deferred from the tool's own reviews

- Post the review from a job that does not execute the package (raises the bar for a
  compromised release; needs an artifact hand-off between jobs).
- Pin the version in CI instead of `@latest` (one line, accepted risk for now).

## 11. Publish the Docker image to GHCR

**Status:** maybe. Not scheduled, and deliberately not a yes.
**Why it is not done:** the Docker lane currently needs `git clone` + `docker build`, so it
only helps someone who already has this repo. `ghcr.io/dandrok/ai-review` would reduce
that to one `docker run`, which is the difference between a lane and a real install path.
But while the only user builds from a clone, a registry buys nothing and adds something to
keep in sync: a tag per release, plus a `latest` that can silently point at an old build.
**Why it is not simply deleted either:** the Docker lane is the only path for a machine
with no Node, and the Dockerfile now builds from `src/` instead of a committed `dist/`,
so it is correct rather than merely present.
**Done (if it ever matters):** `release.yml` pushes `ghcr.io/dandrok/ai-review:<tag>` and
`:latest` using the existing `GITHUB_TOKEN` with `permissions: packages: write` — no PAT,
no new secret — plus a `workflow_dispatch` trigger so the first push happens in CI and
never needs a laptop login. Package visibility must then be flipped to public by hand, or
an unauthenticated `docker run` fails for strangers.
