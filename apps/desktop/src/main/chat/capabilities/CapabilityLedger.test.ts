import { appendFile, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityLedger } from './CapabilityLedger';
import { SessionStore } from '../SessionStore';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, appendFile: vi.fn(actual.appendFile), rename: vi.fn(actual.rename) };
});

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
  it('does not resurrect a native session grant from a snapshot taken before revocation', async () => {
    const { path, store } = await makeLedger();
    const input = {
      subject: { kind: 'session', sessionId: 's' } as const,
      capability: 'files' as const,
      scope: { kind: 'path', value: '/tmp/extra' } as const,
      source: 'approval' as const,
    };
    const native = await store.grant(input);
    const snapshot = {
      roots: [],
      trustedProjects: [],
      permissions: { user: { allow: [], ask: [], deny: [] }, projects: {} },
      sessions: [{ id: 's', grantedDirectories: ['/tmp/extra'] }],
    };
    await store.migrate(snapshot);
    expect((await store.state()).grants).toHaveLength(1);
    await store.revoke(native.id);
    const restarted = new CapabilityLedger(path);
    await restarted.migrate(snapshot);
    expect((await restarted.state()).grants.filter(grant => !grant.revokedAt)).toHaveLength(0);
    // New consent is still handled by the native writer after the historical revoke.
    const renewed = await restarted.grant(input);
    expect(renewed.id).not.toBe(native.id);
    expect((await restarted.state()).grants.filter(grant => !grant.revokedAt)).toHaveLength(1);
  });

  it('migrates persisted explicit session folders after account loading and keeps revoked folders removed', async () => {
    const { path, store } = await makeLedger();
    const sessionsPath = join(path, '..', 'sessions');
    const sessions = new SessionStore(sessionsPath, 'test-model');
    const chat = await sessions.create();
    await sessions.addGrantedDirectory(chat.id, '/tmp/chat-extra');
    const code = await sessions.create(undefined, { mode: 'code' });
    await sessions.setProject(code.id, {
      name: 'project',
      directory: '/tmp/project',
      workingDirectory: '/tmp/worktree',
      branch: 'main',
      workspace: false,
      contextDirectories: ['/tmp/code-extra'],
    });
    const persisted = new SessionStore(sessionsPath, 'test-model');
    const migration = {
      roots: [],
      trustedProjects: [],
      permissions: { user: { allow: [], ask: [], deny: [] }, projects: {} },
      sessions: await persisted.list(),
    };
    await store.migrate(migration);
    await new CapabilityLedger(path).migrate(migration);
    const state = await store.state();
    expect(state.grants).toHaveLength(2);
    expect(state.grants.map(grant => grant.scope.value).sort()).toEqual(['/tmp/chat-extra', '/tmp/code-extra']);
    const chatGrant = state.grants.find(
      grant => grant.subject.kind === 'session' && grant.subject.sessionId === chat.id
    );
    if (!chatGrant) throw new Error('Missing chat directory grant');
    await store.revoke(chatGrant.id, async () => {
      await persisted.removeContextDirectory(chat.id, '/tmp/chat-extra');
    });
    await store.migrate({ ...migration, sessions: await persisted.list() });
    const restarted = await new CapabilityLedger(path).state();
    expect(restarted.grants.filter(grant => !grant.revokedAt).map(grant => grant.scope.value)).toEqual([
      '/tmp/code-extra',
    ]);
    // A repeated legacy snapshot cannot resurrect a grant migrated and then revoked.
    await store.migrate(migration);
    expect((await store.state()).grants.filter(grant => !grant.revokedAt)).toHaveLength(1);
  });

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

  it('revokes immediately', async () => {
    const now = new Date('2026-01-03T00:00:00.000Z');
    const { store } = await makeLedger(() => now);
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
    vi.mocked(appendFile).mockRejectedValueOnce(new Error('disk full'));
    await expect(store.use('credits', { kind: 'tool', value: 'failed' })).rejects.toThrow();

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

  it('writes a whole migration in one append', async () => {
    const { path, store } = await makeLedger();
    vi.mocked(appendFile).mockClear();
    await store.migrate({
      roots: ['/tmp/a', '/tmp/b', '/tmp/a'],
      trustedProjects: ['/tmp/project'],
      permissions: { user: { allow: ['Read', 'Edit'], ask: [], deny: [] }, projects: {} },
    });
    expect(vi.mocked(appendFile)).toHaveBeenCalledTimes(1);
    const { audit } = await new CapabilityLedger(path).state();
    expect([...audit].reverse().map(event => event.sequence)).toEqual([0, 1, 2, 3, 4]);
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

  it('quarantines corrupt persisted data and resumes recording', async () => {
    const { path } = await makeLedger();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await writeFile(path, '{bad', 'utf8');
    const store = new CapabilityLedger(path);
    expect((await store.state()).audit).toEqual([]);
    const files = await readdir(join(path, '..'));
    const quarantine = files.find(file => file.includes('.corrupt-'));
    expect(quarantine).toBeDefined();
    expect(await readFile(join(path, '..', quarantine!), 'utf8')).toBe('{bad');
    expect(diagnostic).toHaveBeenCalled();
    await store.use('credits', { kind: 'tool', value: 'resumed' });
    expect((await new CapabilityLedger(path).state()).audit).toHaveLength(1);
    diagnostic.mockRestore();
  });

  it('quarantines out-of-order JSONL sequences instead of permanently rejecting', async () => {
    const { path, store } = await makeLedger();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await store.use('credits', { kind: 'tool', value: 'generate_image' });
    const persisted = JSON.parse((await readFile(path, 'utf8')).trim()) as { sequence: number };
    persisted.sequence = 4;
    await writeFile(path, JSON.stringify(persisted) + '\n', 'utf8');
    expect((await new CapabilityLedger(path).state()).audit).toEqual([]);
    expect(diagnostic).toHaveBeenCalled();
    diagnostic.mockRestore();
  });

  it('atomically converts legacy v1 JSON, retaining grants, revokes and migration guards', async () => {
    const { path, store } = await makeLedger();
    const migration = {
      roots: ['/tmp/a'],
      trustedProjects: [],
      permissions: { user: { allow: [], ask: [], deny: [] }, projects: {} },
    };
    await store.migrate(migration);
    await store.revoke((await store.state()).grants[0].id);
    const events = (await store.state()).audit.reverse();
    await writeFile(path, JSON.stringify({ version: 1, events }, null, 2), 'utf8');
    vi.mocked(rename).mockClear();
    const restarted = new CapabilityLedger(path);
    expect((await restarted.state()).grants[0].revokedAt).toBeDefined();
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(1);
    await restarted.migrate(migration);
    // Desktop root migration may re-add after real consent is restored; this
    // v1 migration key must still prevent replaying its old snapshot.
    expect((await restarted.state()).grants).toHaveLength(1);
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('preserves the legacy source and retries if atomic conversion fails', async () => {
    const { path, store } = await makeLedger();
    await store.use('tool', { kind: 'tool', value: 'legacy' });
    const legacy = JSON.stringify({ version: 1, events: (await store.state()).audit });
    await writeFile(path, legacy);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(rename).mockRejectedValueOnce(new Error('temporarily unavailable'));
    const restarted = new CapabilityLedger(path);
    await expect(restarted.state()).rejects.toThrow('temporarily unavailable');
    expect(await readFile(path, 'utf8')).toBe(legacy);
    expect((await restarted.state()).audit).toHaveLength(1);
    diagnostic.mockRestore();
  });

  it('repairs a complete final record missing its newline before appending', async () => {
    const { path, store } = await makeLedger();
    await store.use('tool', { kind: 'tool', value: 'first' });
    await writeFile(path, (await readFile(path, 'utf8')).trimEnd());
    await new CapabilityLedger(path).use('tool', { kind: 'tool', value: 'second' });
    expect((await new CapabilityLedger(path).state()).audit.map(event => event.sequence)).toEqual([1, 0]);
  });

  it('preserves a partially written journal for diagnosis and resumes after append failure', async () => {
    const { path, store } = await makeLedger();
    await store.use('tool', { kind: 'tool', value: 'first' });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const filesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(appendFile).mockImplementationOnce(async file => {
      await filesystem.appendFile(file, '{partial');
      throw new Error('disk full');
    });
    await expect(store.use('tool', { kind: 'tool', value: 'failed' })).rejects.toThrow('disk full');
    await store.use('tool', { kind: 'tool', value: 'resumed' });
    expect((await store.state()).audit.map(event => event.sequence)).toEqual([0]);
    const files = await readdir(join(path, '..'));
    const quarantine = files.find(file => file.includes('.corrupt-'));
    expect(await readFile(join(path, '..', quarantine!), 'utf8')).toContain('{partial');
    expect(diagnostic).toHaveBeenCalled();
    diagnostic.mockRestore();
  });

  it('keeps append writes constant-sized and exposes only the 200 most recent events', async () => {
    const { path, store } = await makeLedger();
    vi.mocked(appendFile).mockClear();
    await Promise.all(Array.from({ length: 250 }, () => store.use('tool', { kind: 'tool', value: 'example' })));
    const writes = vi.mocked(appendFile).mock.calls.map(call => String(call[1]));
    expect(writes).toHaveLength(250);
    expect(writes.every(write => write.trim().split('\n').length === 1)).toBe(true);
    for (const state of [await store.state(), await new CapabilityLedger(path).state()]) {
      expect(state.audit).toHaveLength(200);
      expect(state.audit[0].sequence).toBe(249);
      expect(state.audit.at(-1)?.sequence).toBe(50);
    }
  });

  it('retries unreadable storage after the filesystem recovers', async () => {
    const { path } = await makeLedger();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await writeFile(join(path, '..', 'not-directory'), 'x');
    const blockedPath = join(path, '..', 'not-directory', 'ledger');
    const store = new CapabilityLedger(blockedPath);
    await expect(store.state()).rejects.toThrow();
    await rm(join(path, '..', 'not-directory'));
    await store.use('tool', { kind: 'tool', value: 'recovered' });
    expect((await store.state()).audit).toHaveLength(1);
    expect(diagnostic).toHaveBeenCalled();
    diagnostic.mockRestore();
  });

  it('records no revoke when enforcement reports no authority removed', async () => {
    const { store } = await makeLedger();
    const grant = await store.grant({
      subject: { kind: 'desktop-user' },
      capability: 'files',
      scope: { kind: 'path', value: '/tmp/a' },
      source: 'folder-picker',
    });
    await expect(store.revoke(grant.id, () => false)).rejects.toThrow('Access was not removed');
    expect((await store.state()).grants[0].revokedAt).toBeUndefined();
    expect((await store.state()).audit).toHaveLength(1);
  });

  it('isolates session grants, migration history and audit by account scope', async () => {
    const { store } = await makeLedger();
    const input = {
      subject: { kind: 'session', sessionId: 'shared-id', scopeKey: 'account-a' } as const,
      capability: 'files' as const,
      scope: { kind: 'path', value: '/tmp/a' } as const,
      source: 'approval' as const,
    };
    const first = await store.grant(input);
    const second = await store.grant({ ...input, subject: { ...input.subject, scopeKey: 'account-b' } });
    await store.use('files', input.scope, first.id);
    await store.use('files', input.scope, second.id);
    expect((await store.state('account-a')).grants.map(grant => grant.id)).toEqual([first.id]);
    expect((await store.state('account-a')).audit).toHaveLength(2);
    expect((await store.state(null)).grants).toEqual([]);
    expect((await store.state(null)).audit).toEqual([]);
    const enforcement = vi.fn(() => true);
    await expect(store.revoke(first.id, enforcement, 'account-b')).rejects.toThrow('another account');
    expect(enforcement).not.toHaveBeenCalled();
    await store.revoke(first.id, enforcement, 'account-a');
    expect((await store.state('account-a')).grants[0].revokedAt).toBeDefined();
    expect((await store.state('account-b')).grants[0].revokedAt).toBeUndefined();
  });
});
