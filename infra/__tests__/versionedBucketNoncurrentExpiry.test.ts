/**
 * @vitest-environment node
 *
 * Structural guard: every S3 bucket in infra/ declared with versioning tied to ENABLE_BUCKET_VERSIONING
 * must have a lifecycle config that expires noncurrent versions within MAX_NONCURRENT_DAYS. Without one,
 * a delete or overwrite on a versioned stage keeps the old bytes forever.
 *
 * infra/ files use SST globals at module scope, so the source is read as text (same approach as
 * fabFileBucketLifecycle.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const INFRA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_NONCURRENT_DAYS = 30;
const SHARED_RULE = 'expireNoncurrentVersionsRule';

const sources = readdirSync(INFRA_DIR)
  .filter(f => f.endsWith('.ts'))
  .map(f => readFileSync(path.join(INFRA_DIR, f), 'utf8'));

// Each `const x = new sst.aws.Bucket(...)` declaration, bounded by the next bucket or end of file.
const versionedBuckets = sources.flatMap(src =>
  src
    .split(/(?=^const \w+ = new sst\.aws\.Bucket\()/m)
    .filter(chunk => chunk.startsWith('const '))
    .filter(chunk => /versioning:\s*process\.env\.ENABLE_BUCKET_VERSIONING/.test(chunk))
    .map(chunk => ({ name: chunk.match(/^const (\w+)/)![1], src }))
);

// Each BucketLifecycleConfigurationV2 call, up to the next one (or end of file).
const lifecycleFor = (name: string, src: string) =>
  src
    .split('new aws.s3.BucketLifecycleConfigurationV2(')
    .slice(1)
    .find(block => new RegExp(`bucket:\\s*${name}\\.name\\b`).test(block)) ?? '';

const sharedRuleSource = (src: string) =>
  src.match(new RegExp(`const ${SHARED_RULE} = \\{[\\s\\S]*?\\n\\};`))?.[0] ?? '';

describe('versioned buckets expire noncurrent versions', () => {
  it('finds the versioned buckets (guards the guard)', () => {
    expect(versionedBuckets.map(b => b.name)).toEqual(
      expect.arrayContaining([
        'fabFileBucket',
        'generatedImagesBucket',
        'appFilesBucket',
        'historyImportBucket',
        'publishedArtifactsBucket',
      ])
    );
  });

  it.each(versionedBuckets.map(b => [b.name, b.src] as const))('%s has a noncurrent expiry rule', (name, src) => {
    const lifecycle = lifecycleFor(name, src);
    expect(lifecycle, `${name} has no BucketLifecycleConfigurationV2`).not.toBe('');

    const usesShared = lifecycle.includes(SHARED_RULE);
    const ruleText = usesShared ? sharedRuleSource(src) : lifecycle;
    const days = [...ruleText.matchAll(/noncurrentDays:\s*(\d+)/g)].map(m => Number(m[1]));
    expect(days.length, `${name} lifecycle has no noncurrentVersionExpiration`).toBeGreaterThan(0);
    expect(Math.min(...days)).toBeLessThanOrEqual(MAX_NONCURRENT_DAYS);
    // The window must apply to the whole bucket, not only a prefix.
    expect(
      usesShared || /id:\s*'expire-noncurrent-versions',\s*status:\s*'Enabled',\s*filter:\s*\{\}/.test(lifecycle)
    ).toBe(true);
  });
});
