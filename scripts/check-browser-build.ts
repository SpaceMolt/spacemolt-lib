#!/usr/bin/env bun

import { join } from 'node:path';

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, '..', 'src', 'index.ts')],
  target: 'browser',
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log('Browser bundle check passed');
