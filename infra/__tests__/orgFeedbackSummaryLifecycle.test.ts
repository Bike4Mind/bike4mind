/**
 * @vitest-environment node
 *
 * Guard for the class of bug in orgFeedbackSummary.ts: the S3 artifact it writes is reachable
 * only through OrgFeedbackSummaryJob.s3Key, and that job document TTLs out of Mongo on its own
 * schedule. If the bucket's lifecycle prefix drifts from the key the handler actually writes,
 * or its expiration is shortened below the job's TTL, the S3 object either never gets cleaned up
 * or expires while a job still points at it (a live 404 on read).
 *
 * This reads infra/buckets.ts as text rather than importing it: infra/ files reference SST
 * globals ($app, aws.*) at module scope and cannot be imported outside a deploy, same as
 * toolRuntimeAssets.test.ts's handler scan. summaryS3Key itself cannot be imported either - it
 * lives in apps/client, whose `@server/*` alias only resolves under that package's own vitest
 * config, not this root one - so its prefix is likewise extracted from source text rather than
 * re-declared as a local literal, which is what would let the two sides drift silently.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const BUCKETS_SOURCE = readFileSync(path.join(REPO_ROOT, 'infra/buckets.ts'), 'utf8');
const HANDLER_SOURCE = readFileSync(
  path.join(REPO_ROOT, 'apps/client/server/queueHandlers/orgFeedbackSummary.ts'),
  'utf8'
);
const MODEL_SOURCE = readFileSync(
  path.join(REPO_ROOT, 'packages/database/src/models/social/OrgFeedbackSummaryJobModel.ts'),
  'utf8'
);

describe('org feedback summary S3 lifecycle', () => {
  it('finds the expire-org-feedback-summaries rule with a prefix and a day count', () => {
    const ruleMatch = BUCKETS_SOURCE.match(
      /id:\s*'expire-org-feedback-summaries'[\s\S]*?prefix:\s*'([^']+)'[\s\S]*?expiration:\s*\{\s*days:\s*(\d+)/
    );
    expect(ruleMatch).not.toBeNull();
  });

  it('keeps the lifecycle prefix in sync with the key summaryS3Key actually writes', () => {
    const ruleMatch = BUCKETS_SOURCE.match(/id:\s*'expire-org-feedback-summaries'[\s\S]*?prefix:\s*'([^']+)'/);
    const keyMatch = HANDLER_SOURCE.match(/export const summaryS3Key[\s\S]*?=>\s*\n?\s*`([^`]+)`/);

    expect(ruleMatch).not.toBeNull();
    expect(keyMatch).not.toBeNull();

    const lifecyclePrefix = ruleMatch?.[1];
    // The key template's leading static segment, up to its first interpolation - the
    // "org-feedback-summaries/" part of `org-feedback-summaries/${organizationId}/...`.
    const keyLeadingSegment = keyMatch?.[1].split('${')[0];

    expect(lifecyclePrefix).toBe(keyLeadingSegment);
  });

  it('never expires the object before the job pointer that references it', () => {
    const ruleMatch = BUCKETS_SOURCE.match(
      /id:\s*'expire-org-feedback-summaries'[\s\S]*?expiration:\s*\{\s*days:\s*(\d+)/
    );
    const ttlMatch = MODEL_SOURCE.match(/expireAfterSeconds:\s*(\d+)/);

    expect(ruleMatch).not.toBeNull();
    expect(ttlMatch).not.toBeNull();

    const lifecycleDays = Number(ruleMatch?.[1]);
    const pointerTtlSeconds = Number(ttlMatch?.[1]);

    expect(lifecycleDays * 86400).toBeGreaterThanOrEqual(pointerTtlSeconds);
  });
});
