#!/usr/bin/env node
// Verifies internal links, live fact commitments, and the exported fold. Shredded facts lack
// salt, so their commitments cannot be recomputed; an external trusted tip/count is needed
// to prove the export was not truncated or replaced with another internally valid chain.
import { readFile } from 'node:fs/promises';
import { verifyMemoryExport } from '../b4m-core/memory/dist/index.mjs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/verify-memory-export.mjs <export.json>');
  process.exitCode = 2;
} else {
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
