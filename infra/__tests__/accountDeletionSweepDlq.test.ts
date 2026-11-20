// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readInfra = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('account deletion sweep dead letter', () => {
  it('allows export workers to remove versioned uploads after a lost account fence', () => {
    const source = readInfra('queues.ts');
    const start = source.indexOf('const accountDataExportQueueSubscription');
    const block = source.slice(start, source.indexOf('// Publish Thumbnail Queue', start));
    const verify = (value: string) => {
      expect(value).toContain("'s3:ListBucketVersions'");
      expect(value).toContain("'s3:DeleteObjectVersion'");
      expect(value).toContain('resources: [fabFileBucket.arn, $interpolate`${fabFileBucket.arn}/*`]');
    };
    verify(block);
    for (const action of ["'s3:ListBucketVersions'", "'s3:DeleteObjectVersion'"]) {
      expect(() => verify(block.replace(action, ''))).toThrow();
    }
  });

  it('registers a DLQ alarm for the cron-sourced queue', () => {
    const source = readInfra('dlqAlarms.ts');
    const block = source.slice(
      source.indexOf('if (accountDeletionSweepDeadLetter)'),
      source.indexOf('// FabFile Moderation DLQ')
    );
    const verify = (alarm: string) => expect(alarm).toContain('queue: accountDeletionSweepDeadLetter.queue,');
    verify(block);
    expect(() => verify(block.replace('queue: accountDeletionSweepDeadLetter.queue,', ''))).toThrow();
  });

  it('dead-letters the cron run and does not retry it', () => {
    const source = readInfra('cron.ts');
    const block = source.slice(source.indexOf("new sst.aws.Cron('accountDeletionSweep'"));
    const cron = block.slice(0, block.indexOf('if (accountDeletionSweep && accountDeletionSweepDeadLetter)'));
    expect(cron).toContain('transform: accountDeletionSweepDeadLetter.functionTarget,');
    expect(cron).toContain('...accountDeletionSweepDeadLetter.ruleTarget.target,');
    expect(cron).toContain('retries: 0,');
  });

  // Both run completeAccountDeletion, so each needs everything the purge reaches.
  const purgeRunners: Array<[string, () => string]> = [
    [
      'the deletion sweep cron',
      () => {
        const source = readInfra('cron.ts');
        const start = source.indexOf("new sst.aws.Cron('accountDeletionSweep'");
        return source.slice(
          start,
          source.indexOf('if (accountDeletionSweep && accountDeletionSweepDeadLetter)', start)
        );
      },
    ],
    [
      'the admin erasure queue consumer',
      () => {
        const source = readInfra('queues.ts');
        const start = source.indexOf('const accountErasureQueueSubscription');
        return source.slice(start, source.indexOf('SINGLE_RECORD_BATCH', start));
      },
    ],
  ];

  it.each(purgeRunners)('links the resources and scoped permission reached by %s', (_name, readBlock) => {
    const cron = readBlock();
    expect(cron).not.toBe('');
    const required = [
      'eventBus',
      'fabFileBucket',
      'generatedImagesBucket',
      'appFilesBucket',
      'historyImportBucket',
      'publishedArtifactsBucket',
      'routerDistributionId',
    ];
    const links = cron.match(/link: \[([^\]]+)\]/)?.[1] ?? '';
    for (const resource of required) {
      const verifyLink = (value: string) => expect(value.split(',').map(entry => entry.trim())).toContain(resource);
      verifyLink(links);
      expect(() => verifyLink(links.replace(resource, ''))).toThrow();
    }
    const versionPermissions =
      cron.match(/actions: \['s3:ListBucketVersions',[\s\S]*?resources: \[([\s\S]*?)\]/)?.[0] ?? '';
    const verifyVersions = (value: string) => {
      expect(value).toContain("'s3:DeleteObjectVersion'");
      for (const resource of required.filter(name => name.endsWith('Bucket'))) {
        expect(value).toContain(`${resource}.arn,`);
        expect(value).toContain(`$interpolate\`${'${'}${resource}.arn}/*\``);
      }
    };
    verifyVersions(versionPermissions);
    expect(() => verifyVersions(versionPermissions.replace("'s3:DeleteObjectVersion'", ''))).toThrow();
    for (const resource of required.filter(name => name.endsWith('Bucket'))) {
      expect(() => verifyVersions(versionPermissions.replace(`${resource}.arn,`, ''))).toThrow();
    }
    const permission =
      cron.match(/actions: \['cloudfront:CreateInvalidation'\],[\s\S]*?resources: \[([^\]]+)\]/)?.[0] ?? '';
    const action = "actions: ['cloudfront:CreateInvalidation']";
    const distribution = 'router.nodes.cdn.apply(cdn => cdn.nodes.distribution.arn)';
    const verifyPermission = (value: string) => {
      expect(value).toContain(action);
      expect(value).toContain(distribution);
    };
    verifyPermission(permission);
    expect(() => verifyPermission(permission.replace(action, ''))).toThrow();
    expect(() => verifyPermission(permission.replace(distribution, ''))).toThrow();
  });
});
