// Unified-diff parsing. The whole tool is language-agnostic: everything it knows
// about your code comes from git output plus the files on disk.
export interface HunkLine {
  kind: '+' | '-' | ' ';
  text: string;
  newLine?: number;
  oldLine?: number;
}
export interface Hunk {
  header: string;
  lines: HunkLine[];
  newLineNumbers: number[];
}
export interface FileDiff {
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}
export interface UnifiedDiff {
  files: FileDiff[];
  raw: string;
}

const META = /^(index |--- |\+\+\+ |similarity index|rename |old mode|new mode|Binary files|GIT binary patch)/;

export function parseDiff(raw: string): UnifiedDiff {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of raw.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const path = m ? m[2] : line.slice(11);
      cur = { path, isNew: false, isDeleted: false, hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) { cur.isNew = true; continue; }
    if (line.startsWith('deleted file mode')) { cur.isDeleted = true; continue; }
    if (META.test(line)) continue;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : 1;
      newNo = m ? Number(m[2]) : 1;
      hunk = { header: line, lines: [], newLineNumbers: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const c = line[0];
    if (c === '+') {
      hunk.lines.push({ kind: '+', text: line.slice(1), newLine: newNo });
      hunk.newLineNumbers.push(newNo);
      newNo++;
    } else if (c === '-') {
      hunk.lines.push({ kind: '-', text: line.slice(1), oldLine: oldNo });
      oldNo++;
    } else if (c === '\\') {
      continue;
    } else {
      const text = c === ' ' ? line.slice(1) : line;
      hunk.lines.push({ kind: ' ', text, newLine: newNo });
      hunk.newLineNumbers.push(newNo);
      newNo++;
      oldNo++;
    }
  }
  return { files, raw };
}

/** Render the diff with NEW-side line numbers so the model can cite real numbers. */
export function numberedDiff(d: UnifiedDiff): string {
  const out: string[] = [];
  for (const f of d.files) {
    const flags = [f.isNew ? 'new file' : '', f.isDeleted ? 'deleted file' : ''].filter(Boolean).join(', ');
    out.push(`### ${f.path}${flags ? ` (${flags})` : ''}`);
    if (!f.hunks.length) out.push('(no textual hunks — binary or mode-only change)');
    for (const h of f.hunks) {
      out.push(h.header);
      for (const l of h.lines) {
        const n = l.newLine ? String(l.newLine).padStart(5) : '     ';
        out.push(`${l.kind}${n}| ${l.text}`);
      }
    }
  }
  return out.join('\n');
}

/** file path -> set of NEW-side line numbers present in the diff */
export function buildLineIndex(d: UnifiedDiff): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  for (const f of d.files) {
    const lines = new Set<number>();
    for (const h of f.hunks) for (const n of h.newLineNumbers) lines.add(n);
    index.set(f.path, lines);
  }
  return index;
}

export function addedLines(d: UnifiedDiff): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of d.files) {
    out.set(f.path, f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === '+').map((l) => l.text)));
  }
  return out;
}
