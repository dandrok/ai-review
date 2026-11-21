import type { UnifiedDiff } from './diff.ts';
import type { Finding } from './schema.ts';

// Zero-token pass: committed secrets and credential files. Runs alone in a pre-commit
// hook (fast, no network) and before the model in every review.
const SECRET_RULES: { re: RegExp; label: string; severity: 'CRITICAL' | 'WARNING' }[] = [
  { re: /AKIA[0-9A-Z]{16}/, label: 'AWS access key id', severity: 'CRITICAL' },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, label: 'private key block', severity: 'CRITICAL' },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, label: 'GitHub token', severity: 'CRITICAL' },
  { re: /\bsk-[A-Za-z0-9_\-]{20,}/, label: 'API secret key', severity: 'CRITICAL' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack token', severity: 'CRITICAL' },
  { re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/, label: 'JWT literal', severity: 'WARNING' },
  {
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    label: 'hardcoded credential',
    severity: 'CRITICAL',
  },
];

const ALLOW = /(?:placeholder|dummy|xxxx|redacted|changeme|your[_-]?(?:key|token)|process\.env|import\.meta\.env|\$\{|\bexample-)/i;
const CREDENTIAL_FILE = /(^|\/)\.env(\.|$)|(^|\/)id_(?:rsa|ed25519)$|\.pem$/;

export function staticFindings(diff: UnifiedDiff): Finding[] {
  const out: Finding[] = [];
  for (const file of diff.files) {
    if (file.isDeleted) continue;
    if (CREDENTIAL_FILE.test(file.path) && !/\.env\.(example|sample|template)$/.test(file.path)) {
      out.push({
        file: file.path,
        start_line: 1,
        end_line: 1,
        severity: 'WARNING',
        category: 'security',
        title: `Credential file \`${file.path}\` is being committed`,
        rationale: 'This path normally holds live secrets and should be gitignored. Once committed, the value stays in history and must be rotated, not deleted.',
        suggestion: 'Remove it from the commit, add it to `.gitignore`, and commit a `.env.example` with empty values instead.',
      });
      continue;
    }
    if (/(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file.path)) continue;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== '+' || line.newLine === undefined) continue;
        if (line.text.length > 400 || ALLOW.test(line.text)) continue;
        for (const rule of SECRET_RULES) {
          if (!rule.re.test(line.text)) continue;
          out.push({
            file: file.path,
            start_line: line.newLine,
            end_line: line.newLine,
            severity: rule.severity,
            category: 'security',
            title: `Possible ${rule.label} committed`,
            rationale: `The added line matches the shape of a ${rule.label}. Anything committed to git is permanent: removing it in a later commit does not remove it from history, so the value must be rotated.`,
            suggestion: 'Load it from an environment variable or a secret manager, rotate the leaked value, and purge it from history if it was ever pushed.',
          });
          break;
        }
      }
    }
  }
  return out;
}
