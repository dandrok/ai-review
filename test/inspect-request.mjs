// One-shot: capture what the CLI actually sends, then assert the request shape.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const captured = [];
const server = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    captured.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: 'ok', verdict: 'comment', findings: [] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
    );
  });
});

server.listen(8898, '127.0.0.1', () => {
  execFile(
    'node',
    ['/workspace/ai-review/dist/ai-review.mjs', 'review', '--base', 'main', '--quiet', '--format', 'json'],
    { cwd: '/workspace/e2e-demo', env: { ...process.env, AI_REVIEW_BASE_URL: 'http://127.0.0.1:8898', DEEPSEEK_API_KEY: 'dummy' } },
    (err, stdout, stderr) => {
      const req = captured[0];
      const body = req?.body ?? {};
      const sys = body.messages?.[0]?.content ?? '';
      const user = body.messages?.[1]?.content ?? '';
      const order = ['## Diff to review', '### Repository map', '### Full current file', '### Project rules'];
      const positions = order.map((k) => [k, user.indexOf(k)]);
      const out = {
        requests: captured.length,
        url: req?.url,
        authHeader: req?.auth?.slice(0, 12) + '…',
        model: body.model,
        response_format: body.response_format,
        thinking: body.thinking,
        reasoning_effort: body.reasoning_effort,
        max_tokens: body.max_tokens,
        systemChars: sys.length,
        userChars: user.length,
        diffLast: positions.filter(([, p]) => p >= 0),
        hasUntrustedWrapper: user.includes('<untrusted source="diff">'),
        exitCode: err ? Number(err.code) : 0,
        stdin: stdout.slice(0, 120).trim(),
        stderr: stderr.trim().split('\n')[0] ?? '',
      };
      writeFileSync('/tmp/request-shape.json', JSON.stringify(out, null, 2));
      console.log(JSON.stringify(out, null, 2));
      server.close(() => process.exit(0));
    },
  );
});
