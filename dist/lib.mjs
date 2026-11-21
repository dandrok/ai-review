// src/diff.ts
var META = /^(index |--- |\+\+\+ |similarity index|rename |old mode|new mode|Binary files|GIT binary patch)/;
function parseDiff(raw) {
  const files = [];
  let cur = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const path = m ? m[2] : line.slice(11);
      cur = { path, isNew: false, isDeleted: false, hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) {
      cur.isNew = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      cur.isDeleted = true;
      continue;
    }
    if (META.test(line)) continue;
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : 1;
      newNo = m ? Number(m[2]) : 1;
      hunk = { header: line, lines: [], newLineNumbers: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const c = line[0];
    if (c === "+") {
      hunk.lines.push({ kind: "+", text: line.slice(1), newLine: newNo });
      hunk.newLineNumbers.push(newNo);
      newNo++;
    } else if (c === "-") {
      hunk.lines.push({ kind: "-", text: line.slice(1), oldLine: oldNo });
      oldNo++;
    } else if (c === "\\") {
      continue;
    } else {
      const text = c === " " ? line.slice(1) : line;
      hunk.lines.push({ kind: " ", text, newLine: newNo });
      hunk.newLineNumbers.push(newNo);
      newNo++;
      oldNo++;
    }
  }
  return { files, raw };
}
function numberedDiff(d) {
  const out = [];
  for (const f of d.files) {
    const flags = [f.isNew ? "new file" : "", f.isDeleted ? "deleted file" : ""].filter(Boolean).join(", ");
    out.push(`### ${f.path}${flags ? ` (${flags})` : ""}`);
    if (!f.hunks.length) out.push("(no textual hunks \u2014 binary or mode-only change)");
    for (const h of f.hunks) {
      out.push(h.header);
      for (const l of h.lines) {
        const n = l.newLine ? String(l.newLine).padStart(5) : "     ";
        out.push(`${l.kind}${n}| ${l.text}`);
      }
    }
  }
  return out.join("\n");
}
function buildLineIndex(d) {
  const index = /* @__PURE__ */ new Map();
  for (const f of d.files) {
    const lines = /* @__PURE__ */ new Set();
    for (const h of f.hunks) for (const n of h.newLineNumbers) lines.add(n);
    index.set(f.path, lines);
  }
  return index;
}

// src/grounding.ts
function groundFindings(findings, diff) {
  const index = buildLineIndex(diff);
  const kept = [];
  const dropped = [];
  for (const f of findings) {
    const covered = index.get(f.file);
    if (!covered) {
      dropped.push({ finding: f, reason: `file '${f.file}' is not in the diff` });
      continue;
    }
    const lo = Math.min(f.start_line, f.end_line);
    const hi = Math.max(f.start_line, f.end_line);
    let any = false;
    for (let n = lo; n <= hi; n++) if (covered.has(n)) {
      any = true;
      break;
    }
    if (!any) {
      dropped.push({ finding: f, reason: `lines ${lo}-${hi} touch no hunk in '${f.file}'` });
      continue;
    }
    kept.push({ ...f, start_line: lo, end_line: hi });
  }
  return { kept, dropped };
}
function anchorLine(f, diff) {
  const covered = buildLineIndex(diff).get(f.file);
  if (!covered) return null;
  const lo = Math.min(f.start_line, f.end_line);
  const hi = Math.max(f.start_line, f.end_line);
  if (covered.has(hi)) return hi;
  if (covered.has(lo)) return lo;
  for (let n = lo; n <= hi; n++) if (covered.has(n)) return n;
  return null;
}

// src/gate.ts
var RANK = { SUGGESTION: 1, WARNING: 2, CRITICAL: 3 };
var MIN = { never: Infinity, critical: 3, warning: 2, any: 1 };
var ICON = { CRITICAL: "\u{1F534}", WARNING: "\u{1F7E1}", SUGGESTION: "\u{1F535}" };
function countBlockers(findings, failOn) {
  return findings.filter((f) => (RANK[f.severity] ?? 0) >= MIN[failOn]).length;
}
function commentBody(f, agent) {
  const payload = JSON.stringify({
    v: 1,
    id: f.id,
    rule: f.category,
    severity: f.severity,
    file: f.file,
    line: f.start_line,
    end_line: f.end_line
  });
  return [
    `${ICON[f.severity]} **${f.title}** (${f.severity.toLowerCase()} \xB7 ${f.category} \xB7 ${agent})`,
    "",
    f.rationale,
    f.suggestion ? `
**Fix:** ${f.suggestion}` : "",
    "",
    `<!-- ai-review:v1 ${payload} -->`
  ].filter((l) => l !== "").join("\n");
}
function toReviewPayload(opts) {
  const blockers = countBlockers(opts.findings, opts.failOn);
  const event = opts.gate && blockers > 0 ? "REQUEST_CHANGES" : "COMMENT";
  const comments = opts.findings.flatMap((f) => {
    const line = anchorLine(f, opts.diff);
    return line === null ? [] : [{ path: f.file, line, body: commentBody(f, opts.agent) }];
  });
  const counts = opts.findings.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }), {});
  const header = opts.findings.length === 0 ? "## \u{1F916} AI review \u2014 no findings" : `## \u{1F916} AI review \u2014 ${blockers} blocker(s), ${opts.findings.length} finding(s)${opts.gate && blockers ? " \xB7 changes requested" : ""}`;
  const table = opts.findings.length > 0 ? [
    "| Sev | Finding | Where |",
    "|---|---|---|",
    ...opts.findings.map((f) => `| ${ICON[f.severity]} ${f.severity.toLowerCase()} | ${f.title} | \`${f.file}:${f.start_line}\` |`)
  ].join("\n") : "_Nothing worth flagging on this diff._";
  const footer = [
    `_${opts.model} \xB7 ${opts.findings.length} kept, ${opts.droppedCount} dropped as ungrounded \xB7 ${opts.contextChars} ctx + ${opts.diffChars} diff chars \xB7 $${opts.costUsd.toFixed(4)}_`,
    "_Findings are grounded to diff lines; the verdict is computed from severities in code, not by the model. A human merges._"
  ].join("\n\n");
  return {
    event,
    comments,
    body: [header, "", opts.summary, "", table, "", footer].join("\n")
  };
}

// src/schema.ts
var SEVERITIES = ["CRITICAL", "WARNING", "SUGGESTION"];
var CATEGORIES = ["security", "correctness", "performance", "spec", "maintainability"];
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function validateReview(raw) {
  const errors = [];
  if (!isObj(raw)) return { review: null, errors: ["root is not a JSON object"] };
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) errors.push("summary: missing or not a string");
  const verdict = raw.verdict;
  const okVerdict = verdict === "approve" || verdict === "comment" || verdict === "request_changes";
  if (!okVerdict) errors.push("verdict: must be one of approve | comment | request_changes");
  const rawFindings = Array.isArray(raw.findings) ? raw.findings : [];
  if (!Array.isArray(raw.findings)) errors.push("findings: must be an array");
  const findings = [];
  rawFindings.forEach((f, i) => {
    if (!isObj(f)) {
      errors.push(`findings[${i}]: not an object`);
      return;
    }
    const file = typeof f.file === "string" ? f.file.replace(/^\.?\/+/, "").trim() : "";
    const severity = String(f.severity ?? "").toUpperCase();
    const category = String(f.category ?? "").toLowerCase();
    const start = Number(f.start_line);
    const end = Number(f.end_line ?? f.start_line);
    const title = typeof f.title === "string" ? f.title.trim() : "";
    const rationale = typeof f.rationale === "string" ? f.rationale.trim() : "";
    const suggestion = typeof f.suggestion === "string" ? f.suggestion.trim() : "";
    if (!file) errors.push(`findings[${i}].file: empty`);
    if (!Number.isInteger(start) || start < 1) errors.push(`findings[${i}].start_line: not a positive integer`);
    if (!SEVERITIES.includes(severity)) errors.push(`findings[${i}].severity: "${String(f.severity)}" not in ${SEVERITIES.join("|")}`);
    if (!CATEGORIES.includes(category)) errors.push(`findings[${i}].category: "${String(f.category)}" not in ${CATEGORIES.join("|")}`);
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
      rationale: rationale.slice(0, 2e3),
      suggestion: suggestion.slice(0, 2e3)
    });
  });
  if (errors.length) return { review: null, errors };
  return {
    review: { summary, verdict, findings },
    errors: []
  };
}

// src/dedup.ts
var RANK2 = { SUGGESTION: 1, WARNING: 2, CRITICAL: 3 };
var norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
function dedupFindings(findings) {
  const sorted = [...findings].sort((a, b) => (RANK2[b.severity] ?? 0) - (RANK2[a.severity] ?? 0));
  const kept = [];
  for (const f of sorted) {
    const dup = kept.find((k) => {
      if (k.file !== f.file) return false;
      const overlap = Math.min(k.end_line, f.end_line) - Math.max(k.start_line, f.start_line);
      const sameSpot = overlap >= 0;
      const a = norm(f.title);
      const b = norm(k.title);
      const similarTitle = a === b || a.length > 20 && b.length > 20 && (a.includes(b.slice(0, 24)) || b.includes(a.slice(0, 24)));
      return sameSpot && (similarTitle || k.category === f.category);
    });
    if (!dup) kept.push(f);
  }
  return kept;
}

// src/static.ts
var SECRET_RULES = [
  { re: /AKIA[0-9A-Z]{16}/, label: "AWS access key id", severity: "CRITICAL" },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, label: "private key block", severity: "CRITICAL" },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, label: "GitHub token", severity: "CRITICAL" },
  { re: /\bsk-[A-Za-z0-9_\-]{20,}/, label: "API secret key", severity: "CRITICAL" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, label: "Slack token", severity: "CRITICAL" },
  { re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/, label: "JWT literal", severity: "WARNING" },
  {
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    label: "hardcoded credential",
    severity: "CRITICAL"
  }
];
var ALLOW = /(?:placeholder|dummy|xxxx|redacted|changeme|your[_-]?(?:key|token)|process\.env|import\.meta\.env|\$\{|\bexample-)/i;
var CREDENTIAL_FILE = /(^|\/)\.env(\.|$)|(^|\/)id_(?:rsa|ed25519)$|\.pem$/;
function staticFindings(diff) {
  const out = [];
  for (const file of diff.files) {
    if (file.isDeleted) continue;
    if (CREDENTIAL_FILE.test(file.path) && !/\.env\.(example|sample|template)$/.test(file.path)) {
      out.push({
        file: file.path,
        start_line: 1,
        end_line: 1,
        severity: "WARNING",
        category: "security",
        title: `Credential file \`${file.path}\` is being committed`,
        rationale: "This path normally holds live secrets and should be gitignored. Once committed, the value stays in history and must be rotated, not deleted.",
        suggestion: "Remove it from the commit, add it to `.gitignore`, and commit a `.env.example` with empty values instead."
      });
      continue;
    }
    if (/(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file.path)) continue;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== "+" || line.newLine === void 0) continue;
        if (line.text.length > 400 || ALLOW.test(line.text)) continue;
        for (const rule of SECRET_RULES) {
          if (!rule.re.test(line.text)) continue;
          out.push({
            file: file.path,
            start_line: line.newLine,
            end_line: line.newLine,
            severity: rule.severity,
            category: "security",
            title: `Possible ${rule.label} committed`,
            rationale: `The added line matches the shape of a ${rule.label}. Anything committed to git is permanent: removing it in a later commit does not remove it from history, so the value must be rotated.`,
            suggestion: "Load it from an environment variable or a secret manager, rotate the leaked value, and purge it from history if it was ever pushed."
          });
          break;
        }
      }
    }
  }
  return out;
}

// src/config.ts
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") i++;
        re += "(?:.*/)?";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if ("\\^$.|+()[]{}".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("^" + re + "$");
}
function ignored(path, patterns) {
  return patterns.some((p) => globToRegExp(p).test(path));
}

// src/llm.ts
var PRICES = {
  "deepseek-flash": { hit: [3e-3, 6e-3], miss: [0.15, 0.3], out: [0.6, 1.2] },
  "deepseek-v4-pro": { hit: [0.022, 0.044], miss: [0.66, 1.32], out: [1.98, 3.96] }
};
function isPeak(now = /* @__PURE__ */ new Date()) {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = now.getUTCHours();
  return h >= 1 && h < 4 || h >= 6 && h < 10;
}
function estimateCost(model, usage, now = /* @__PURE__ */ new Date()) {
  const key = Object.keys(PRICES).find((k) => model.includes(k)) ?? "deepseek-flash";
  const p = PRICES[key];
  const i = isPeak(now) ? 1 : 0;
  return usage.cache_hit_tokens * p.hit[i] / 1e6 + usage.cache_miss_tokens * p.miss[i] / 1e6 + usage.completion_tokens * p.out[i] / 1e6;
}

// src/context.ts
function touchedSymbols(diff) {
  const names = /* @__PURE__ */ new Set();
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/,
    /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /(?:^|\s)def\s+([A-Za-z_]\w*)/,
    /(?:^|\s)fn\s+([A-Za-z_]\w*)/,
    /(?:^|\s)func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/
  ];
  for (const file of diff.files) {
    if (file.isNew) continue;
    for (const hunk of file.hunks) {
      const enclosing = /@@.*@@\s*(.+)$/.exec(hunk.header);
      if (enclosing) {
        const m = /([A-Za-z_$][\w$]{3,})/.exec(enclosing[1]);
        if (m) names.add(m[1]);
      }
      for (const line of hunk.lines) {
        if (line.kind === "-") continue;
        for (const re of patterns) {
          const m = re.exec(line.text);
          if (m) {
            names.add(m[1]);
            break;
          }
        }
      }
    }
  }
  const stop = /* @__PURE__ */ new Set(["default", "handler", "render", "constructor", "returnv", "then", "catch"]);
  return [...names].filter((n) => n.length >= 4 && !stop.has(n)).slice(0, 10);
}

// src/env.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
function loadDotEnv(dirs, names = [".env", ".env.local"]) {
  const files = [];
  const vars = [];
  const seen = /* @__PURE__ */ new Set();
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const path = join(dir, name);
      if (seen.has(path) || !existsSync(path)) continue;
      seen.add(path);
      let text;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      files.push(path);
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1];
        let value = m[2].trim();
        const quoted = value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'");
        if (quoted) value = value.slice(1, -1);
        else value = value.replace(/\s+#.*$/, "").trim();
        if (process.env[key] !== void 0) continue;
        process.env[key] = value;
        if (!vars.includes(key)) vars.push(key);
      }
    }
  }
  return { files, vars };
}

// src/init.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, writeFileSync, chmodSync } from "node:fs";
import { join as join2, dirname } from "node:path";
import { fileURLToPath } from "node:url";
var HERE = dirname(fileURLToPath(import.meta.url));
var TEMPLATES = join2(HERE, "..", "templates");
var GITIGNORE_BLOCK = [
  "# --- secrets: never commit these ---",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "*.pem",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  "# --- ai-review run artifacts ---",
  ".ai-review/"
];
function ensureGitignore(root) {
  const path = join2(root, ".gitignore");
  const existing = existsSync2(path) ? readFileSync2(path, "utf8") : "";
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = GITIGNORE_BLOCK.filter((l) => !have.has(l));
  if (!missing.length) return [".gitignore already covers secrets"];
  const header = existing.endsWith("\n") || !existing ? "" : "\n";
  const body = existing + header + (existing ? "\n" : "") + missing.join("\n") + "\n";
  writeFileSync(path, body);
  return [`${existing ? "updated" : "created"} .gitignore (+${missing.filter((l) => !l.startsWith("#")).length} pattern(s))`];
}
export {
  anchorLine,
  buildLineIndex,
  countBlockers,
  dedupFindings,
  ensureGitignore,
  estimateCost,
  globToRegExp,
  groundFindings,
  ignored,
  isPeak,
  loadDotEnv,
  numberedDiff,
  parseDiff,
  staticFindings,
  toReviewPayload,
  touchedSymbols,
  validateReview
};
