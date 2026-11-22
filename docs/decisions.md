# Settled decisions

Not a backlog — the opposite. These are calls that were made deliberately, with the
reason, so a later session (or a later me) does not re-derive them from scratch. If you
want to reverse one, reverse it here first and say what changed.

The tool's own reviewer raises some of these repeatedly, because it is stateless and
cannot see this file. That is expected; the answer is accepted-risk memory
(see backlog #6), not a longer prompt.

---

## 1. Comment-only. No gate. Ever, for now.

`fail_on: never` in every repo that adopts it.

**Why:** a gate is for a team with a norm to enforce. A solo developer gains nothing by
having an opinion block their push, and loses plenty — the first false CRITICAL teaches
`--no-verify`, which then also skips the deterministic checks. Every reviewer tool that
died, died of this.

**Revisit if:** a team adopts it *and* measured precision is above ~70% across ten real
PRs. Not before.

## 2. One model, one call, no multi-agent.

**Why:** four specialists cost 4× and then need dedupe to hide the overlap they create.
A single prompt carrying three packs plus a `category` field gives the same triage.
The dedupe stage existing at all is the tell.

## 3. No hosted service, no proxy.

**Why:** the key belongs in the repo's Actions secret. A proxy adds a secret whose only
job is to guard another secret, plus an uptime obligation. One user, one model, no
reason.

## 4. Not a product.

**Why:** the defensible part is ~600 lines anyone can copy in a day, much of it derived
from a public workshop. The market has teams, IDE integration and dashboards. Shipping
this as a product means a support surface, a security-review obligation for every
customer repo, and a maintenance treadmill with no revenue.

**Revisit only if** it develops something structurally different: real spec-drift review
against actual specifications, or an agent `--fix` loop with a measured acceptance rate.
"Another AI code reviewer" is not that.

## 5. Prompt tuning is not the lever for repeated findings.

**Why:** the tool is stateless by design, so it re-derives every judgement from the diff.
Longer instructions do not give it a memory. Accepted-risk memory does, and it is worth
building only when the repeats actually annoy someone.

## 6. The packs are the real asset.

**Why:** they encode hard-won judgement (the anti-pattern list in `packs/security.md` is
what stops a model reporting `eval()` with no principal and no effect). The plumbing
around them is replaceable; the packs are not, and they work in Claude Code, Codex,
Antigravity or anything else that takes a system prompt. Extracting them as a portable
skill is a task — see backlog.

## 7. Deterministic gates fail closed; judgements never block.

**Why:** a secrets check that can silently no-op is worse than no check at all. An
opinion about a loop being an N+1 cannot gate a merge. These two rules resolve the
contradictory advice two review rounds gave about the same hook line — see backlog #4.

## 8. No `pre-commit` framework hook. No committed `dist/`.

`.pre-commit-hooks.yaml` was deleted and `dist/` is gitignored. The two decisions are
joined at the hip, so reverse them together.

**Why:** `language: node` installs this package with
`npm install -g git+file://<clone>`, which runs the `prepare` script — in a bare clone.
Measured, not assumed: at `prepare` time `node_modules` does not exist at all, so the
esbuild build cannot run and the install fails. Making `prepare` install its own
devDependencies first fails the same way. The only way to satisfy it is to commit the
compiled `dist/` so npm has something to pack.

**What replaced it:** `ai-review init` now writes both git hooks (it used to write only
pre-push, leaving the free offline secrets scan unreachable), and Docker covers repos
with no Node. Neither needs anything committed.

**Cost accepted:** a repo that uses the `pre-commit` framework can no longer add this
with one YAML block, and `language: node` no longer bootstraps Node for Node-less repos.
A repo with no Node and no Docker has no install path.

**Revisit if:** npm starts installing devDependencies before `prepare`, or the build is
rewritten to need no build-time dependency.
