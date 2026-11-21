import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal .env loader (no dependency). Never prints or logs a value: callers get the
 * NAMES only, so a secret cannot reach a log line.
 *
 * Rules: a variable already present in the real environment always wins, so a committed
 * .env can never override a CI secret.
 */
export function loadDotEnv(dirs: string[], names = ['.env', '.env.local']): { files: string[]; vars: string[] } {
  const files: string[] = [];
  const vars: string[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const path = join(dir, name);
      if (seen.has(path) || !existsSync(path)) continue;
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

/** Names are safe to print; values are not. */
export function describeEnvLoad(res: { files: string[]; vars: string[] }): string | null {
  if (!res.files.length) return null;
  const names = res.vars.length ? res.vars.join(', ') : 'no new variables';
  return `loaded ${res.files.length} env file(s) (${names})`;
}
