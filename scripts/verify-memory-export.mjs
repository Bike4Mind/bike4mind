#!/usr/bin/env node
// Verifies internal links, live fact commitments, and the exported fold. Shredded facts lack
// salt, so their commitments cannot be recomputed; an external trusted tip/count is needed
// to prove the export was not truncated or replaced with another internally valid chain.
// Event and belief subjects are HMACs (the chain hash covers them), so this proves integrity but
// cannot show what a subject was.
import { readFile } from 'node:fs/promises';

const BUILD_HINT = 'build first: pnpm --filter @bike4mind/memory build';
const path = process.argv[2];
if (!path) {
  console.error(`Usage: node scripts/verify-memory-export.mjs <export.json>  (${BUILD_HINT})`);
  process.exitCode = 2;
} else {
  let verifyMemoryExport;
  try {
    ({ verifyMemoryExport } = await import('../b4m-core/memory/dist/index.mjs'));
  } catch (error) {
    console.error(
      `Could not load the memory package (${BUILD_HINT}): ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(2);
  }
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    const result = verifyMemoryExport(data);
    if (!result.ok) throw new Error(result.error);
    console.log(`Verified ${data.events.length} events and ${data.beliefs.length} beliefs`);
  } catch (error) {
    console.error(`Memory export verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
