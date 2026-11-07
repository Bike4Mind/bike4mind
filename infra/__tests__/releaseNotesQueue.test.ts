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

describe("What's New queue subscription", () => {
  // The handler throws on the first failed record, so a larger batch would re-post earlier records on redelivery.
  it('delivers one record at a time to the kind-routing handler', () => {
    const start = QUEUES.indexOf('const whatsNewGenerationQueueSubscription = whatsNewGenerationQueue.subscribe(');
    expect(start).toBeGreaterThanOrEqual(0);
    const sub = QUEUES.slice(start, QUEUES.indexOf('\n);', start));
    expect(sub).toMatch(/handler:\s*'apps\/workers\/src\/queueHandlers\/whatsNewJob\.dispatch'/);
    expect(sub).toMatch(/SINGLE_RECORD_BATCH\s*$/);
  });
});
