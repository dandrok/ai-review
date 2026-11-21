export const SEVERITIES = ['CRITICAL', 'WARNING', 'SUGGESTION'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const CATEGORIES = ['security', 'correctness', 'performance', 'spec', 'maintainability'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Finding {
  file: string;
  start_line: number;
  end_line: number;
  severity: Severity;
  category: Category;
  title: string;
  rationale: string;
  suggestion: string;
  /** stable-ish id derived from file+line+rule, added after validation */
  id?: string;
}

export interface Review {
  summary: string;
  findings: Finding[];
  verdict: 'approve' | 'comment' | 'request_changes';
}

/** The output contract, described to the model. Hand-written: DeepSeek supports json_object, not json_schema. */
export const OUTPUT_CONTRACT = `Reply with a single JSON object, no prose, no markdown fence:
{
  "summary": "2-3 sentences: what this change does and whether it is safe to merge",
  "verdict": "approve" | "comment" | "request_changes",
  "findings": [
    {
      "file": "repo/relative/path/from/the/diff",
      "start_line": 12,
      "end_line": 14,
      "severity": "CRITICAL" | "WARNING" | "SUGGESTION",
      "category": "security" | "correctness" | "performance" | "spec" | "maintainability",
      "title": "one short sentence naming the defect, in plain language",
      "rationale": "1-2 sentences a busy reviewer reads once: what breaks, for whom, and why this code makes it happen. No restating the diff, no bullet lists, no jargon.",
      "suggestion": "the smallest concrete fix: one sentence, or a short snippet. \"\" when there is none"
    }
  ]
}
Line numbers are NEW-side numbers, copied from the numbered diff. "findings": [] is a valid and common answer.`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateReview(raw: unknown): { review: Review | null; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { review: null, errors: ['root is not a JSON object'] };

  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) errors.push('summary: missing or not a string');

  const verdict = raw.verdict;
  const okVerdict = verdict === 'approve' || verdict === 'comment' || verdict === 'request_changes';
  if (!okVerdict) errors.push('verdict: must be one of approve | comment | request_changes');

  const rawFindings = Array.isArray(raw.findings) ? raw.findings : [];
  if (!Array.isArray(raw.findings)) errors.push('findings: must be an array');

  const findings: Finding[] = [];
  rawFindings.forEach((f, i) => {
    if (!isObj(f)) { errors.push(`findings[${i}]: not an object`); return; }
    const file = typeof f.file === 'string' ? f.file.replace(/^\.?\/+/, '').trim() : '';
    const severity = String(f.severity ?? '').toUpperCase() as Severity;
    const category = String(f.category ?? '').toLowerCase() as Category;
    const start = Number(f.start_line);
    const end = Number(f.end_line ?? f.start_line);
    const title = typeof f.title === 'string' ? f.title.trim() : '';
    const rationale = typeof f.rationale === 'string' ? f.rationale.trim() : '';
    const suggestion = typeof f.suggestion === 'string' ? f.suggestion.trim() : '';

    if (!file) errors.push(`findings[${i}].file: empty`);
    if (!Number.isInteger(start) || start < 1) errors.push(`findings[${i}].start_line: not a positive integer`);
    if (!SEVERITIES.includes(severity)) errors.push(`findings[${i}].severity: "${String(f.severity)}" not in ${SEVERITIES.join('|')}`);
    if (!CATEGORIES.includes(category)) errors.push(`findings[${i}].category: "${String(f.category)}" not in ${CATEGORIES.join('|')}`);
    if (!title) errors.push(`findings[${i}].title: empty`);
    if (!rationale) errors.push(`findings[${i}].rationale: empty`);
    if (errors.length > 12) return;
    if (!file || !title || !rationale) return;
    if (!SEVERITIES.includes(severity) || !CATEGORIES.includes(category)) return;

    findings.push({
      file,
      start_line: Math.trunc(start),
      end_line: Number.isInteger(end) && end >= start ? Math.trunc(end) : Math.trunc(start),
      severity,
      category,
      title: title.slice(0, 200),
      rationale: rationale.slice(0, 2000),
      suggestion: suggestion.slice(0, 2000),
    });
  });

  if (errors.length) return { review: null, errors };
  return {
    review: { summary, verdict: verdict as Review['verdict'], findings },
    errors: [],
  };
}
