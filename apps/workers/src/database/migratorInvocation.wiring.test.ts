import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../../../..');

// The migrator runs inside the deploy. A migration that writes FabFiles fires these Lambdas
// immediately, so they must already carry the new code or they reject rows they do not know yet.
describe('DatabaseMigratorInvocation ordering', () => {
  it('waits for the FabFile ingest Lambdas to deploy before running migrations', () => {
    const infra = readFileSync(resolve(repoRoot, 'infra/database.ts'), 'utf8');
    const invocation = infra.slice(infra.indexOf("'DatabaseMigratorInvocation'"));
    const dependsOn = invocation.match(/dependsOn:\s*\[([^\]]*)\]/);

    expect(dependsOn, 'DatabaseMigratorInvocation has no dependsOn list').not.toBeNull();
    const deps = (dependsOn?.[1] ?? '').split(',').map(dep => dep.trim());
    expect(deps).toEqual(
      expect.arrayContaining([
        'fabFileBucketNotification',
        'fabFileChunkQueueSubscription',
        'fabFileVectorizeQueueSubscription',
      ])
    );
  });
});
