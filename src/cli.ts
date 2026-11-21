import { runReview, type RunOptions } from './run.ts';
import { initProject, installHooks, selfCommand } from './init.ts';
import { loadEnv, describeEnvLoad } from './env.ts';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DiffMode } from './git.ts';
import type { Effort, FailOn } from './config.ts';

const VERSION = '0.1.0';

const HELP = `ai-review ${VERSION} — diff-grounded AI code review, one cheap model.

Usage
  ai-review review [options]        review the current diff
  ai-review init [--force] [--no-hooks] [--no-workflow]
  ai-review install-hooks [--pre-commit] [--pre-push]
  ai-review --version | --help

Review options
  --staged              review staged changes (pre-commit)
  --worktree            review uncommitted changes vs HEAD
  --commit <sha>        review a single commit
  --base <ref>          review <ref>...HEAD (default: origin/main, main, master…)
  --static-only         no model call: secrets scan only (fast, free)
  --dry-run             print the context plan and stop, no model call
  --mock <file>         replay a JSON review instead of calling the model
  --fail-on <level>     never | critical | warning | any   (default: critical)
  --effort <level>      none | low | high | max            (default: high)
  --packs <a,b>         packs to merge   (default: security,correctness)
  --model <name>        default: deepseek-flash
  --max-findings <n>    default: 8
  --format <fmt>        terminal | json | markdown
  --post / --no-post    post as a GitHub PR review when in CI
  --quiet               only print findings

Environment
  DEEPSEEK_API_KEY   required unless --mock / --static-only
  AI_REVIEW_BASE_URL OpenAI-compatible base URL (default https://api.deepseek.com)
  GITHUB_TOKEN       to post the PR review (GITHUB_REPOSITORY, PR number are auto-detected)
`;

export function parseArgs(argv: string[]): { cmd: string; opts: RunOptions; flags: Record<string, boolean | string> } {
  const [cmd = 'review', ...rest] = argv;
  const opts: RunOptions = { mode: 'range' };
  const flags: Record<string, boolean | string> = {};
  const need = (i: number, name: string) => {
    const v = rest[i];
    if (v === undefined) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '--staged': opts.mode = 'staged'; break;
      case '--worktree': opts.mode = 'worktree'; break;
      case '--commit': opts.mode = 'commit'; opts.base = need(++i, a); break;
      case '--base': opts.mode = 'range'; opts.base = need(++i, a); break;
      case '--static-only': opts.staticOnly = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--mock': opts.mock = need(++i, a); break;
      case '--fail-on': opts.failOn = need(++i, a) as FailOn; break;
      case '--effort': opts.effort = need(++i, a) as Effort; break;
      case '--packs': opts.packs = need(++i, a).split(',').map((s) => s.trim()); break;
      case '--model': opts.model = need(++i, a); break;
      case '--max-findings': opts.maxFindings = Number(need(++i, a)); break;
      case '--format': opts.format = need(++i, a) as RunOptions['format']; break;
      case '--post': opts.post = true; break;
      case '--no-post': opts.post = false; break;
      case '--quiet': case '-q': opts.quiet = true; break;
      case '--pr-title': opts.prTitle = need(++i, a); break;
      case '--pr-body': opts.prBody = need(++i, a); break;
      case '--force': flags.force = true; break;
      case '--no-hooks': flags.noHooks = true; break;
      case '--no-workflow': flags.noWorkflow = true; break;
      case '--pre-commit': flags.preCommit = true; break;
      case '--pre-push': flags.prePush = true; break;
      case '--version': case '-v': flags.version = true; break;
      case '--help': case '-h': flags.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
        break;
    }
  }
  return { cmd, opts, flags };
}

async function main() {
  const argv = process.argv.slice(2);
  const toolDir = dirname(fileURLToPath(import.meta.url)) + '/..';
  const envNote = describeEnvLoad(loadEnv(process.cwd(), toolDir));
  if (envNote) process.stderr.write(`ai-review: ${envNote}\n`);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP);
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(VERSION);
    return 0;
  }
  const { cmd, opts, flags } = parseArgs(argv);
  if (flags.version) { console.log(VERSION); return 0; }
  if (flags.help) { console.log(HELP); return 0; }

  if (cmd === 'init') {
    const log = initProject({
      force: Boolean(flags.force),
      hooks: !flags.noHooks,
      workflow: !flags.noWorkflow,
    });
    console.log(log.join('\n'));
    console.log(`\nNext: add DEEPSEEK_API_KEY to your environment (or repo secrets). Tool entry: ${selfCommand()}`);
    return 0;
  }

  if (cmd === 'install-hooks') {
    const both = !flags.preCommit && !flags.prePush;
    const written = installHooks({ preCommit: both || Boolean(flags.preCommit), prePush: both || Boolean(flags.prePush) });
    console.log(written.join('\n'));
    return 0;
  }

  if (cmd !== 'review') throw new Error(`unknown command: ${cmd}`);
  const { exitCode } = await runReview(opts);
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`ai-review: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  });
