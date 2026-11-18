/**
 * @vitest-environment node
 *
 * The price snapshot hand-off: bucket only where scheduled jobs run, discovery may write the one key,
 * the usage poller may read it. infra/cron.ts uses SST globals at module scope, so it is read, not imported.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../cron.ts', import.meta.url), 'utf8');

describe('model price snapshot wiring in infra/cron.ts', () => {
  it('uses the key the workers read and write', () => {
    const shared = readFileSync(
      new URL('../../b4m-core/common/src/types/entities/ModelPriceSnapshot.ts', import.meta.url),
      'utf8'
    );
    const key = /MODEL_PRICE_SNAPSHOT_KEY = '([^']+)'/.exec(shared)?.[1];
    expect(key).toBeTruthy();
    expect(source).toContain(`const MODEL_PRICE_SNAPSHOT_KEY = '${key}';`);
  });

  it('creates the bucket only where scheduled jobs run', () => {
    expect(source).toContain(
      'const modelPriceSnapshotBucket = runsScheduledJobs ? createModelPriceSnapshotBucket() : undefined;'
    );
  });

  it('hands the bucket name to both Lambdas and scopes each one to the single object', () => {
    expect(source).toMatch(/modelPriceSnapshotObjectArn\s*\?\s*\[\{ actions: \['s3:PutObject'\]/);
    expect(source).toMatch(/modelPriceSnapshotObjectArn\s*\?\s*\[\{ actions: \['s3:GetObject'\]/);
    const discovery = source.slice(source.indexOf("new sst.aws.Function('modelDiscoveryFunction'"));
    expect(discovery.slice(0, discovery.indexOf('});'))).toContain('...modelPriceSnapshotAccess.write');
    const poller = source.slice(source.indexOf("new sst.aws.Cron('providerUsagePoll'"));
    const pollerBlock = poller.slice(0, poller.indexOf('})'));
    expect(pollerBlock).toContain('...modelPriceSnapshotAccess.read');
    expect(pollerBlock).toContain('...modelPriceSnapshotAccess.environment');
  });

  it('reads the env var name the workers use', () => {
    const common = readFileSync(
      new URL('../../b4m-core/common/src/types/entities/ModelPriceSnapshot.ts', import.meta.url),
      'utf8'
    );
    expect(common).toContain("'MODEL_PRICE_SNAPSHOT_BUCKET'");
    expect(source).toContain('MODEL_PRICE_SNAPSHOT_BUCKET: modelPriceSnapshotBucket.name');
  });
});
