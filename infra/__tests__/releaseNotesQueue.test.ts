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
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const QUEUES = read('infra/queues.ts');

describe("What's New queue subscription", () => {
  // The handler throws on the first failed record, so a larger batch would re-post earlier records on redelivery.
  it('delivers one record at a time to the kind-routing handler', () => {
    const start = QUEUES.indexOf('const whatsNewGenerationQueueSubscription = whatsNewGenerationQueue.subscribe(');
    expect(start).toBeGreaterThanOrEqual(0);
    const sub = QUEUES.slice(start, QUEUES.indexOf('\n);', start));
    expect(sub).toMatch(/handler:\s*'apps\/workers\/src\/queueHandlers\/whatsNewJob\.dispatch'/);
    expect(sub).toMatch(/SINGLE_RECORD_BATCH\s*$/);
  });

  // Release notes and highlights share one queue and one consumer; a second highlights queue would split them again.
  it("is the only What's New consumer: the legacy highlights queue is gone", () => {
    expect(QUEUES).not.toMatch(/whatsNewHighlightsQueue/);
    expect(QUEUES).not.toMatch(/queueHandlers\/whatsNewHighlights\.dispatch/);
    expect(QUEUES.match(/queueHandlers\/whatsNewJob\.dispatch/g)).toHaveLength(1);
  });

  it('the admin highlights producer sends a kind-tagged message to the merged queue', () => {
    const producer = read('apps/client/pages/api/admin/generate-highlights.ts');
    expect(producer).toMatch(/kind:\s*'highlights'/);
    expect(producer).toMatch(/\.whatsNewGenerationQueue;/);
    expect(producer).not.toMatch(/whatsNewHighlightsQueue/);
  });

  it('no infra file still links or alarms on the legacy highlights queue', () => {
    for (const file of ['infra/web.ts', 'infra/dlqAlarms.ts', 'infra/logMonitor.ts', 'infra/cron.ts']) {
      expect(read(file), file).not.toMatch(/whatsNewHighlightsQueue|'whats-new-highlights'/);
    }
  });
});
