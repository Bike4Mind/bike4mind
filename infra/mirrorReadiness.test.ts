import { describe, expect, it } from 'vitest';
import { mirrorReadinessFailures } from './mirrorReadiness';
import { readFileSync } from 'node:fs';

const roleUris: Record<string, string> = {
  MONGODB_URI: 'mongodb://legacy@db/test',
  MONGODB_APP_URI: 'mongodb://app@db/test',
  MONGODB_WORKER_URI: 'mongodb://worker@db/test',
  MONGODB_MIGRATION_URI: 'mongodb://migration@db/test',
};
const boundary = { runtimeUsesDedicatedRoles: true, includedWritersInstrumented: true };

describe('mirror database readiness', () => {
  it('rejects absent, shared, or placeholder role secrets without disclosing values', () => {
    expect(mirrorReadinessFailures(() => undefined, boundary)).toHaveLength(4);
    expect(
      mirrorReadinessFailures(name => ({ ...roleUris, MONGODB_WORKER_URI: roleUris.MONGODB_URI })[name], boundary)
    ).toContain('MONGODB_WORKER_URI shares the legacy credential');
    expect(
      mirrorReadinessFailures(name => ({ ...roleUris, MONGODB_APP_URI: 'not-configured' })[name], boundary)
    ).toContain('MONGODB_APP_URI is not configured');
  });

  it('does not treat configured credentials alone as an enforced boundary', () => {
    expect(
      mirrorReadinessFailures(name => roleUris[name], { ...boundary, runtimeUsesDedicatedRoles: false })
    ).toContain('Runtime still has access to the shared database credential');
    expect(
      mirrorReadinessFailures(name => roleUris[name], { ...boundary, includedWritersInstrumented: false })
    ).toContain('Included writers are not instrumented');
  });

  it('keeps the deploy and feed gates closed while runtime links and writers remain unmigrated', () => {
    const secrets = readFileSync(new URL('./secrets.ts', import.meta.url), 'utf8');
    expect(secrets).toContain("process.env.MIRROR_FEED_ENABLED !== 'false'");
    expect(secrets).toContain('runtimeUsesDedicatedRoles: false');
    expect(secrets).toContain('includedWritersInstrumented: false');
    const outbox = readFileSync(
      new URL('../packages/database/src/models/content/OwnerMutationLogModel.ts', import.meta.url),
      'utf8'
    );
    expect(outbox).toContain('databasePrivilegesEnforced: false');
    expect(outbox).toContain('includedWritersInstrumented: false');
    expect(
      secrets.slice(secrets.indexOf('export const allSecrets ='), secrets.indexOf('export const allSecrets =') + 110)
    ).not.toContain('mirrorDatabaseSecrets');
  });
});
