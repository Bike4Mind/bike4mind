import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CapabilityLedger } from './CapabilityLedger';

const directories: string[] = [];

async function makeLedger(now = () => new Date('2026-01-01T00:00:00.000Z')) {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-capabilities-'));
  directories.push(directory);
  const path = join(directory, 'capability-ledger.json');
  return { path, store: new CapabilityLedger(path, now) };
}

afterEach(async () =>
  Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
);

describe('CapabilityLedger', () => {
  it('deduplicates repeated concurrent grants of the same session authority until revoked', async () => {
    const { store } = await makeLedger();
    const input = {
      subject: { kind: 'session', sessionId: 's' } as const,
      capability: 'tool' as const,
      scope: { kind: 'tool', value: 'bash_execute' } as const,
      approvalKey: 'bash_execute:git status',
      source: 'approval' as const,
    };
    const grants = await Promise.all([store.grant(input), store.grant(input), store.grant(input)]);
    expect(new Set(grants.map(grant => grant.id)).size).toBe(1);
    expect((await store.state()).grants).toHaveLength(1);
    await store.revoke(grants[0].id);
    const renewed = await store.grant(input);
    expect(renewed.id).not.toBe(grants[0].id);
    expect((await store.state()).grants.filter(grant => !grant.revokedAt)).toHaveLength(1);
  });

  it('deduplicates normalized session paths without conflating sessions or approval keys', async () => {
    const { store } = await makeLedger();
    const input = {
      subject: { kind: 'session', sessionId: 's' } as const,
      capability: 'files' as const,
      scope: { kind: 'path', value: '/tmp/a' } as const,
      source: 'approval' as const,
    };
    const first = await store.grant(input);
    expect((await store.grant({ ...input, scope: { kind: 'path', value: '/tmp/a/../a' } })).id).toBe(first.id);
    await store.grant({ ...input, subject: { kind: 'session', sessionId: 'other' } });
    await store.grant({ ...input, approvalKey: 'first-key' });
    await store.grant({ ...input, approvalKey: 'second-key' });
    expect((await store.state()).grants).toHaveLength(4);
  });

  it('serializes concurrent appends in audit order and writes owner-only', async () => {
    const { path, store } = await makeLedger();
    await Promise.all([
      store.use('credits', { kind: 'tool', value: 'generate_image' }),
      store.use('browser-origin', { kind: 'browser-origin', value: 'https://example.com/a', access: 'network' }),
      store.use('files', { kind: 'path', value: '/tmp/a' }),
    ]);
    const state = await store.state();
    expect([...state.audit].reverse().map(event => event.sequence)).toEqual([0, 1, 2]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('expires once and revokes immediately', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const { store } = await makeLedger(() => now);
    const expiring = await store.grant({
      subject: { kind: 'desktop-user' },
      capability: 'files',
      scope: { kind: 'path', value: '/tmp/a' },
      source: 'folder-picker',
      expiresAt: '2026-01-02T00:00:00.000Z',
    });
    now = new Date('2026-01-03T00:00:00.000Z');
    expect((await store.state()).grants.find(grant => grant.id === expiring.id)?.expiredAt).toBe(now.toISOString());
    expect((await store.state()).audit.filter(event => event.type === 'expire')).toHaveLength(1);

    const active = await store.grant({
      subject: { kind: 'desktop-user' },
      capability: 'tool',
      scope: { kind: 'tool', value: 'x' },
      source: 'approval',
    });
    await store.revoke(active.id);
    expect((await store.state()).grants.find(grant => grant.id === active.id)?.revokedAt).toBe(now.toISOString());
    expect(await store.revoke(active.id)).toBeNull();
  });

  it('does not claim revocation when enforcement fails', async () => {
    const { store } = await makeLedger();
    const grant = await store.grant({
      subject: { kind: 'desktop-user' },
      capability: 'files',
      scope: { kind: 'path', value: '/tmp/a' },
      source: 'folder-picker',
    });
    await expect(
      store.revoke(grant.id, () => {
        throw new Error('disk full');
      })
    ).rejects.toThrow('disk full');
    expect((await store.state()).grants.find(entry => entry.id === grant.id)?.revokedAt).toBeUndefined();
  });

  it('expires exactly once when multiple readers observe the deadline together', async () => {
    const { store } = await makeLedger();
    await store.grant({
      subject: { kind: 'desktop-user' },
      capability: 'files',
      scope: { kind: 'path', value: '/tmp/a' },
      source: 'folder-picker',
      expiresAt: '2025-12-31T00:00:00.000Z',
    });
    await Promise.all([store.state(), store.state(), store.state()]);
    expect((await store.state()).audit.filter(event => event.type === 'expire')).toHaveLength(1);
  });

  it('enforces concurrent revocation only once and lets readers observe the completed transition', async () => {
    const { store } = await makeLedger();
    const grant = await store.grant({
      subject: { kind: 'desktop-user' },
      capability: 'files',
      scope: { kind: 'path', value: '/tmp/a' },
      source: 'folder-picker',
    });
    let enforced = 0;
    const enforce = () => {
      enforced += 1;
    };
    const [first, second, state] = await Promise.all([
      store.revoke(grant.id, enforce),
      store.revoke(grant.id, enforce),
      store.state(),
    ]);
    expect(first?.id).toBe(grant.id);
    expect(second).toBeNull();
    expect(enforced).toBe(1);
    expect(state.grants[0].revokedAt).toBeDefined();
    expect(state.audit.filter(event => event.type === 'revoke')).toHaveLength(1);
  });

  it('keeps processing transitions after enforcement rejects', async () => {
    const { store } = await makeLedger();
    const grant = await store.grant({
      subject: { kind: 'desktop-user' },
      capability: 'files',
      scope: { kind: 'path', value: '/tmp/a' },
      source: 'folder-picker',
    });
    await expect(
      store.revoke(grant.id, () => {
        throw new Error('disk full');
      })
    ).rejects.toThrow('disk full');
    await store.revoke(grant.id);
    expect((await store.state()).grants[0].revokedAt).toBeDefined();
  });

  it('recovers after a failed persistence attempt without advancing the audit sequence', async () => {
    const { path, store } = await makeLedger();
    await store.use('credits', { kind: 'tool', value: 'first' });
    await mkdir(`${path}.tmp`);
    await expect(store.use('credits', { kind: 'tool', value: 'failed' })).rejects.toThrow();
    await rm(`${path}.tmp`, { recursive: true });
    await store.use('credits', { kind: 'tool', value: 'second' });
    const audit = (await new CapabilityLedger(path).state()).audit;
    expect(audit.map(event => event.sequence)).toEqual([1, 0]);
    expect(audit.map(event => event.type === 'use' && event.scope.value)).toEqual(['second', 'first']);
  });

  it('migrates normalized grants idempotently', async () => {
    const { path, store } = await makeLedger();
    const migration = {
      roots: ['/tmp/a/../a'],
      trustedProjects: ['/tmp/project'],
      permissions: { user: { allow: ['WebFetch(domain:example.com)'], ask: [], deny: [] }, projects: {} },
    };
    await store.migrate(migration);
    await store.migrate(migration);
    const state = await new CapabilityLedger(path).state();
    expect(state.grants).toHaveLength(3);
    expect(state.grants.find(grant => grant.capability === 'files')?.scope).toEqual({ kind: 'path', value: '/tmp/a' });
  });

  it('keeps anonymous origin, imported identity and script grants separate', async () => {
    const { store } = await makeLedger();
    for (const [capability, access] of [
      ['browser-origin', 'act'],
      ['imported-identity', 'read'],
      ['imported-identity', 'script'],
    ] as const) {
      await store.grant({
        subject: { kind: 'session', sessionId: 's' },
        capability,
        scope: { kind: 'browser-origin', value: 'https://example.com/private', access },
        source: 'approval',
      });
    }
    const grants = (await store.state()).grants;
    expect(
      grants.map(grant => [grant.capability, grant.scope.kind === 'browser-origin' && grant.scope.access])
    ).toEqual(
      expect.arrayContaining([
        ['imported-identity', 'script'],
        ['imported-identity', 'read'],
        ['browser-origin', 'act'],
      ])
    );
  });

  it('deduplicates repeated normalized inputs and simultaneous migration attempts', async () => {
    const { path, store } = await makeLedger();
    const migration = {
      roots: ['/tmp/a', '/tmp/a/../a'],
      trustedProjects: ['/tmp/project', '/tmp/project'],
      permissions: { user: { allow: ['Read', 'Read'], ask: [], deny: [] }, projects: {} },
    };
    await Promise.all([store.migrate(migration), store.migrate(migration)]);
    expect((await new CapabilityLedger(path).state()).grants).toHaveLength(3);
  });

  it('preserves the precise approval key across a restart', async () => {
    const { path, store } = await makeLedger();
    await store.grant({
      subject: { kind: 'session', sessionId: 's' },
      capability: 'tool',
      scope: { kind: 'tool', value: 'write_file' },
      source: 'approval',
      approvalKey: 'write_file:/tmp/a',
    });
    expect((await new CapabilityLedger(path).state()).grants[0].approvalKey).toBe('write_file:/tmp/a');
  });

  it('does not remigrate a permission already recorded by the native grant path', async () => {
    const { path, store } = await makeLedger();
    await store.grant({
      subject: { kind: 'desktop-user' },
      capability: 'files',
      scope: { kind: 'path', value: '/tmp/a' },
      source: 'folder-picker',
    });
    await store.grant({
      subject: { kind: 'project', directory: '/tmp/project' },
      capability: 'project-trust',
      scope: { kind: 'project', value: '/tmp/project' },
      source: 'project-trust',
    });
    await store.grant({
      subject: { kind: 'desktop-user' },
      capability: 'tool',
      scope: { kind: 'permission-rule', value: 'Read' },
      source: 'permission-rule',
    });
    const migration = {
      roots: ['/tmp/a'],
      trustedProjects: ['/tmp/project'],
      permissions: { user: { allow: ['Read'], ask: [], deny: [] }, projects: {} },
    };
    await new CapabilityLedger(path).migrate(migration);
    await new CapabilityLedger(path).migrate(migration);
    expect((await new CapabilityLedger(path).state()).grants).toHaveLength(3);
  });

  it('fails closed on corrupt persisted data', async () => {
    const { path } = await makeLedger();
    await writeFile(path, '{bad', 'utf8');
    await expect(new CapabilityLedger(path).state()).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('{bad');
  });

  it('rejects an audit log whose sequence is not append order', async () => {
    const { path, store } = await makeLedger();
    await store.use('credits', { kind: 'tool', value: 'generate_image' });
    const persisted = JSON.parse(await readFile(path, 'utf8')) as {
      version: number;
      events: Array<{ sequence: number }>;
    };
    persisted.events[0].sequence = 4;
    await writeFile(path, JSON.stringify(persisted), 'utf8');
    await expect(new CapabilityLedger(path).state()).rejects.toThrow();
  });
});
