import type { Finding } from './schema.ts';

const RANK: Record<string, number> = { SUGGESTION: 1, WARNING: 2, CRITICAL: 3 };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Same root cause reported twice (same file, same category, near-identical title
 * or overlapping lines) collapses into the highest-severity instance.
 */
export function dedupFindings(findings: Finding[]): Finding[] {
  const sorted = [...findings].sort((a, b) => (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0));
  const kept: Finding[] = [];
  for (const f of sorted) {
    const dup = kept.find((k) => {
      if (k.file !== f.file) return false;
      const overlap = Math.min(k.end_line, f.end_line) - Math.max(k.start_line, f.start_line);
      const sameSpot = overlap >= 0;
      const a = norm(f.title);
      const b = norm(k.title);
      const similarTitle = a === b || (a.length > 20 && b.length > 20 && (a.includes(b.slice(0, 24)) || b.includes(a.slice(0, 24))));
      return sameSpot && (similarTitle || k.category === f.category);
    });
    if (!dup) kept.push(f);
  }
  return kept;
}

export function assignIds(findings: Finding[]): Finding[] {
  return findings.map((f, i) => ({ ...f, id: `${f.category}-${i + 1}-${f.file.split('/').pop() ?? 'file'}:${f.start_line}` }));
}
