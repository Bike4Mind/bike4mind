/**
 * @vitest-environment node
 *
 * Guard for the fab-file bucket's expire-notebook-exports rule: nothing in the app deletes a
 * notebook export (storeExportFile hands back a 1h signed URL and forgets the key), so the
 * lifecycle rule is the only reaper. If its prefix drifts from the key storeExportFile writes,
 * exports silently accumulate forever.
 *
 * Both sides are read as text for the same reasons as orgFeedbackSummaryLifecycle.test.ts:
 * infra/ files use SST globals at module scope, and the producer's prefix is extracted from
 * source rather than re-declared here, which is what would let the two drift silently.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const BUCKETS_SOURCE = readFileSync(path.join(REPO_ROOT, 'infra/buckets.ts'), 'utf8');
const EXPORT_SERVICE_SOURCE = readFileSync(
  path.join(REPO_ROOT, 'b4m-core/services/src/notebookExportService/index.ts'),
  'utf8'
);

const RULE_PATTERN =
  /id:\s*'expire-notebook-exports'[\s\S]*?prefix:\s*'([^']+)'[\s\S]*?expiration:\s*\{\s*days:\s*(\d+)/;

describe('fab-file bucket notebook export lifecycle', () => {
  it('finds the expire-notebook-exports rule with a prefix and a day count', () => {
    expect(BUCKETS_SOURCE.match(RULE_PATTERN)).not.toBeNull();
  });

  it('keeps the lifecycle prefix in sync with the key storeExportFile actually writes', () => {
    const ruleMatch = BUCKETS_SOURCE.match(RULE_PATTERN);
    const keyMatch = EXPORT_SERVICE_SOURCE.match(/storeExportFile\([\s\S]*?const path = `([^`]+)`/);

    expect(ruleMatch).not.toBeNull();
    expect(keyMatch).not.toBeNull();

    // The key template's leading static segment - the "exports/" of `exports/${uuidv4()}/...`.
    const keyLeadingSegment = keyMatch?.[1].split('${')[0];

    expect(ruleMatch?.[1]).toBe(keyLeadingSegment);
  });

  it('expires exports after 1 day, S3 minimum and well past the 1h signed URL', () => {
    expect(Number(BUCKETS_SOURCE.match(RULE_PATTERN)?.[2])).toBe(1);
  });
});
