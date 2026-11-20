/**
 * @vitest-environment node
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const QUEUES = readFileSync(path.join(REPO_ROOT, 'infra/queues.ts'), 'utf8');

const cut = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return source.slice(from, source.indexOf(end, from));
};

describe('fabFileVectorizeQueue subscription', () => {
  // The handler hands a rate-denied record back as a batch item failure
  // (returnRecordForRedelivery). Without partialResponses Lambda ignores that response and deletes
  // the message, so a denied file is silently dropped on its first delivery and never embedded.
  // The handler and helper tests mock that seam, so only this test fails if the option goes.
  it('reads one record at a time and honours partial batch responses', () => {
    const sub = cut(QUEUES, 'const fabFileVectorizeQueueSubscription = fabFileVectorizeQueue.subscribe(', '\n);');
    expect(sub).toMatch(/handler:\s*'apps\/workers\/src\/queueHandlers\/fabFileVectorize\.dispatch'/);
    expect(sub).toMatch(/batch:\s*\{\s*size:\s*1,\s*partialResponses:\s*true\s*\}/);
  });
});
