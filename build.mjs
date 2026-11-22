import * as esbuild from 'esbuild';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  legalComments: 'none',
  // package.json is the only place the version is written down.
  define: { __AI_REVIEW_VERSION__: JSON.stringify(version) },
};
await esbuild.build({ ...shared, entryPoints: ['src/cli.ts'], outfile: 'dist/ai-review.mjs', banner: { js: '#!/usr/bin/env node' } });
chmodSync('dist/ai-review.mjs', 0o755);
// Internal modules, for the test suite only.
await esbuild.build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'dist/lib.mjs' });
console.log('built dist/ai-review.mjs + dist/lib.mjs');
