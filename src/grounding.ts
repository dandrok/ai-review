import type { UnifiedDiff } from './diff.ts';
import { buildLineIndex } from './diff.ts';
import type { Finding } from './schema.ts';

export interface Dropped {
  finding: Finding;
  reason: string;
}

/**
 * A finding survives only if its file is in the diff and its range touches a real hunk.
 * This single filter removes most hallucinated locations, which is what makes an
 * AI reviewer tolerable.
 */
export function groundFindings(findings: Finding[], diff: UnifiedDiff): { kept: Finding[]; dropped: Dropped[] } {
  const index = buildLineIndex(diff);
  const kept: Finding[] = [];
  const dropped: Dropped[] = [];
  for (const f of findings) {
    const covered = index.get(f.file);
    if (!covered) {
      dropped.push({ finding: f, reason: `file '${f.file}' is not in the diff` });
      continue;
    }
    const lo = Math.min(f.start_line, f.end_line);
    const hi = Math.max(f.start_line, f.end_line);
    let any = false;
    for (let n = lo; n <= hi; n++) if (covered.has(n)) { any = true; break; }
    if (!any) {
      dropped.push({ finding: f, reason: `lines ${lo}-${hi} touch no hunk in '${f.file}'` });
      continue;
    }
    kept.push({ ...f, start_line: lo, end_line: hi });
  }
  return { kept, dropped };
}

/** GitHub can only anchor a comment on a line that exists in the diff. */
export function anchorLine(f: Finding, diff: UnifiedDiff): number | null {
  const covered = buildLineIndex(diff).get(f.file);
  if (!covered) return null;
  const lo = Math.min(f.start_line, f.end_line);
  const hi = Math.max(f.start_line, f.end_line);
  if (covered.has(hi)) return hi;
  if (covered.has(lo)) return lo;
  for (let n = lo; n <= hi; n++) if (covered.has(n)) return n;
  return null;
}
