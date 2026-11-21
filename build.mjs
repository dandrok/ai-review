import * as esbuild from 'esbuild';
import { chmodSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  legalComments: 'none',
};
await esbuild.build({ ...shared, entryPoints: ['src/cli.ts'], outfile: 'dist/ai-review.mjs', banner: { js: '#!/usr/bin/env node' } });
chmodSync('dist/ai-review.mjs', 0o755);
// Internal modules, for the test suite only.
await esbuild.build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'dist/lib.mjs' });
console.log('built dist/ai-review.mjs + dist/lib.mjs');
