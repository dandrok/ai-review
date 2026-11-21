import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal .env loader (no dependency). Never prints or logs a value: callers get the
 * NAMES only, so a secret cannot reach a log line.
 *
 * Rules: a variable already present in the real environment always wins, so a committed
 * .env can never override a CI secret.
 */
export function loadDotEnvFiles(paths: string[]): { files: string[]; vars: string[] } {
  const files: string[] = [];
  const vars: string[] = [];
  const seen = new Set<string>();

  {
    for (const path of paths) {
      if (!path || seen.has(path) || !existsSync(path)) continue;
      seen.add(path);
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      files.push(path);
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1];
        let value = m[2].trim();
        const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
        if (quoted) value = value.slice(1, -1);
        else value = value.replace(/\s+#.*$/, '').trim();
        if (process.env[key] !== undefined) continue;
        process.env[key] = value;
        if (!vars.includes(key)) vars.push(key);
      }
    }
  }
  return { files, vars };
}

/** Per-directory convenience wrapper: <dir>/.env then <dir>/.env.local. */
export function loadDotEnv(dirs: string[], names = ['.env', '.env.local']): { files: string[]; vars: string[] } {
  const paths: string[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) paths.push(join(dir, name));
  }
  return loadDotEnvFiles(paths);
}

/**
 * Global key file, so one DEEPSEEK_API_KEY serves every repo:
 * $XDG_CONFIG_HOME/ai-review/env, ~/.config/ai-review/env, or ~/.ai-review.env.
 * Loaded after the project files, so a project .env still wins.
 */
export function globalKeyFiles(home?: string, xdgConfigHome?: string): string[] {
  const h = home ?? process.env.HOME ?? '';
  if (!h) return [];
  // An explicit home (tests, or a caller pinning a user) must not be overridden by the
  // ambient XDG_CONFIG_HOME: CI runners set it, which made this resolve outside the home.
  const x = xdgConfigHome ?? (home === undefined ? process.env.XDG_CONFIG_HOME ?? '' : '');
  const configDir = x || join(h, '.config');
  return [join(configDir, 'ai-review', 'env'), join(h, '.ai-review.env')];
}

/**
 * Everything the CLI loads for a repo, first match per variable wins:
 * the repo's own files → the global key file → a .env sitting next to the installed tool.
 */
export function loadEnv(cwd: string, toolDir = '') {
  const paths = [join(cwd, '.env'), join(cwd, '.env.local'), ...globalKeyFiles()];
  if (toolDir) paths.push(join(toolDir, '.env'));
  return loadDotEnvFiles(paths);
}

/** Names are safe to print; values are not. */
export function describeEnvLoad(res: { files: string[]; vars: string[] }): string | null {
  if (!res.files.length) return null;
  const names = res.vars.length ? res.vars.join(', ') : 'no new variables';
  return `loaded ${res.files.length} env file(s) (${names})`;
}
