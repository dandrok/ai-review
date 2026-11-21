// Local stub of the OpenAI-compatible endpoint. Verifies the HTTP path, the
// JSON retry (first reply fails schema validation), usage parsing and cost.
import { createServer } from 'node:http';

let calls = 0;
const bodies = [];

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls++;
    bodies.push(JSON.parse(body));
    let content;
    if (calls === 1) {
      // wrong enum -> must trigger the validation retry, not a crash
      content = JSON.stringify({
        summary: 'x',
        verdict: 'lgtm',
        findings: [{ file: 'src/export.ts', start_line: 8, severity: 'HIGH', category: 'perf', title: 't', rationale: 'r' }],
      });
    } else if (calls === 2) {
      content = 'not json at all';
    } else {
      content = JSON.stringify({
        summary: 'Export endpoint re-queries sections per row and does not scope by tenant.',
        verdict: 'request_changes',
        findings: [
          {
            file: 'src/export.ts',
            start_line: 8,
            severity: 'CRITICAL',
            category: 'performance',
            title: 'N+1 query inside the export loop',
            rationale: 'Awaiting query() inside the for loop over res.rows issues one round-trip per document.',
            suggestion: 'Fetch all sections with a single `where doc_id = any($1)` and group in memory.',
          },
          {
            file: 'src/export.ts',
            start_line: 5,
            severity: 'CRITICAL',
            category: 'security',
            title: 'Missing tenant scope on export',
            rationale: '`where id = $1` has no tenant_id predicate, unlike loadDoc in src/docs.ts, so any user can export another tenant document.',
            suggestion: 'Add `and tenant_id = $2` and pass the session tenant.',
          },
        ],
      });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'stub',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 18432, completion_tokens: 512, prompt_cache_hit_tokens: 16384, prompt_cache_miss_tokens: 2048 },
      }),
    );
  });
});

server.listen(8899, '127.0.0.1', () => console.log('stub listening on 8899'));

process.on('SIGTERM', () => {
  console.log(JSON.stringify({ calls, lastBodyKeys: Object.keys(bodies.at(-1) ?? {}), systemChars: bodies.at(-1)?.messages?.[0]?.content?.length }));
  server.close(() => process.exit(0));
});
