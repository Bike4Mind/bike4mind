import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImportScopeChangedError, SessionStore } from './SessionStore';
import { type SessionScope, sessionScopeForChat, sessionScopeKey } from './sessionScope';
import type { AuthState } from '@shared/auth';
import type { ChatProject, ChatSession } from '@shared/chat';

const MODEL = 'test-model';

const LOCAL = 'http://localhost:3000';
const HOSTED = 'https://app.bike4mind.com';
const ALICE = 'account-alice';
const BOB = 'account-bob';

/**
 * A store over a root whose scope the test moves, the way the auth state moves under the real
 * one. `at(null)` is a sign-out or the window in the middle of an environment switch.
 */
function scopedStore(root: string): { store: SessionStore; at: (scope: SessionScope | null) => void } {
  let current: SessionScope | null = null;
  const store = new SessionStore(root, MODEL, 'launch-one', () => current);
  return {
    store,
    at: scope => {
      current = scope;
    },
  };
}

function scope(environmentUrl: string, accountId: string): SessionScope {
  return { environmentUrl, accountId };
}

describe('SessionStore scoping', () => {
  let root: string;
  let store: SessionStore;
  let at: (scope: SessionScope | null) => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'b4m-scoped-'));
    ({ store, at } = scopedStore(root));
  });

  it('files a conversation under its environment and account, not loose in the root', async () => {
    at(scope(LOCAL, ALICE));
    const { id } = await store.create();

    expect(await readdir(root)).toEqual([sessionScopeKey(scope(LOCAL, ALICE))]);
    expect(await readdir(join(root, sessionScopeKey(scope(LOCAL, ALICE))))).toEqual([`${id}.json`]);
  });

  it('refuses a folder removal queued under a different account', async () => {
    at(scope(LOCAL, ALICE));
    const created = await store.create();
    await store.addGrantedDirectory(created.id, '/alice/private');
    const expectedScope = store.scopeKey();
    at(scope(LOCAL, BOB));
    expect(await store.removeContextDirectory(created.id, '/alice/private', expectedScope)).toBeNull();
    at(scope(LOCAL, ALICE));
    expect((await store.get(created.id))?.grantedDirectories).toEqual(['/alice/private']);
  });

  it.each(['chat', 'code'] as const)('refuses a %s folder grant queued under another account', async mode => {
    at(scope(LOCAL, ALICE));
    const created = await store.create(undefined, {
      mode,
      ...(mode === 'code'
        ? {
            project: {
              directory: '/project',
              name: 'project',
              workingDirectory: '/project',
              branch: 'main',
              workspace: false,
              contextDirectories: [],
            },
          }
        : {}),
    });
    const original = await store.get(created.id);
    const expectedScope = store.scopeKey();
    at(scope(LOCAL, BOB));
    await store.create();
    await writeFile(join(root, sessionScopeKey(scope(LOCAL, BOB)), `${created.id}.json`), JSON.stringify(original));
    const grant =
      mode === 'code'
        ? store.addContextDirectory(created.id, '/alice/private', expectedScope)
        : store.addGrantedDirectory(created.id, '/alice/private', expectedScope);
    expect(await grant).toBeNull();
    const unchanged = await store.get(created.id);
    expect(unchanged?.grantedDirectories).toBeUndefined();
    expect(unchanged?.project?.contextDirectories ?? []).toEqual([]);
  });

  it('shows the other environment nothing, and gives it all back on the way home', async () => {
    at(scope(LOCAL, ALICE));
    const local = await store.create();
    await store.appendMessage(local.id, {
      id: 'm1',
      role: 'user',
      content: 'held against the dev server',
      createdAt: new Date().toISOString(),
    });

    at(scope(HOSTED, ALICE));
    expect(await store.list()).toEqual([]);
    const hosted = await store.create();

    at(scope(LOCAL, ALICE));
    expect((await store.list()).map(entry => entry.id)).toEqual([local.id]);
    expect((await store.get(local.id))?.messages[0]?.content).toBe('held against the dev server');

    // And the environment switched away from kept its own, rather than being cleaned up.
    at(scope(HOSTED, ALICE));
    expect((await store.list()).map(entry => entry.id)).toEqual([hosted.id]);
  });

  it('shows one account nothing of another on the same backend', async () => {
    at(scope(LOCAL, ALICE));
    const hers = await store.create();

    at(scope(LOCAL, BOB));
    expect(await store.list()).toEqual([]);
    expect(await store.get(hers.id)).toBeNull();
  });

  it('does not apply queued history consent to a recurring id in another account', async () => {
    at(scope(LOCAL, ALICE));
    const session = await store.create();
    const original = await store.get(session.id);
    const expectedScope = store.scopeKey();
    at(scope(LOCAL, BOB));
    await store.create();
    await writeFile(join(root, sessionScopeKey(scope(LOCAL, BOB)), `${session.id}.json`), JSON.stringify(original));
    at(scope(LOCAL, ALICE));
    const pendingRename = store.rename(session.id, 'Renamed in Alice');
    const consent = store.setHistoryEnabled(session.id, true, expectedScope);
    at(scope(LOCAL, BOB));
    await pendingRename;
    expect(await consent).toBeNull();
    expect((await store.get(session.id))?.historyEnabled).toBeUndefined();
  });

  it('lists nothing while nobody is signed in', async () => {
    at(scope(LOCAL, ALICE));
    await store.create();

    at(null);
    expect(await store.list()).toEqual([]);
  });

  it('refuses to start a conversation with no account to file it under', async () => {
    at(null);
    await expect(store.create()).rejects.toThrow(/no account is signed in/);
  });

  it('finishes a turn that was in flight when the environment went away', async () => {
    at(scope(LOCAL, ALICE));
    const { id } = await store.create();

    // What an environment switch looks like from here: the scope drops while the reply is
    // still settling. The tail belongs to the conversation that started it.
    at(null);
    await store.appendMessage(id, { id: 'm1', role: 'user', content: 'mid-switch', createdAt: '2026-01-01T00:00:00Z' });

    at(scope(LOCAL, ALICE));
    expect((await store.get(id))?.messages.map(message => message.content)).toEqual(['mid-switch']);
  });

  // A read-change-write resolves the scope ONCE. With a scope that moves under it - which is
  // what an environment switch landing between the two halves looks like - the alternative
  // files the conversation it just read into the folder of the account now signed in.
  it('writes a session back to the folder it was read from, not the one signed in by then', async () => {
    at(scope(LOCAL, ALICE));
    const { id } = await store.create();

    const moving = [scope(LOCAL, ALICE), scope(HOSTED, BOB), scope(HOSTED, BOB)];
    const shifting = new SessionStore(root, MODEL, 'launch-one', () => moving.shift() ?? scope(HOSTED, BOB));
    expect(await shifting.rename(id, 'named at home')).toMatchObject({ title: 'named at home' });

    at(scope(HOSTED, BOB));
    expect(await store.list()).toEqual([]);
    at(scope(LOCAL, ALICE));
    expect((await store.get(id))?.title).toBe('named at home');
  });

  it('stays out of the auth vault however the account id is spelled', async () => {
    at(scope(LOCAL, '../..'));
    await store.create();
    at(scope('http://../../auth-vault', '../auth-vault'));
    await store.create();

    // Two folders, both immediately inside the root, and nothing written beside it.
    const entries = await readdir(root);
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(entry).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

describe('SessionStore migration of unscoped conversations', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'b4m-legacy-'));
  });

  async function writeLegacy(id: string, body: Record<string, unknown>): Promise<void> {
    await writeFile(join(root, `${id}.json`), JSON.stringify(body, null, 2), 'utf8');
  }

  it('adopts what is already on disk into the scope that is signed in', async () => {
    await writeLegacy('legacy-one', {
      id: 'legacy-one',
      title: 'from before scoping',
      model: 'old-model',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      messages: [{ id: 'm1', role: 'user', content: 'still here', createdAt: '2026-01-01T00:00:00.000Z' }],
    });

    const { store, at } = scopedStore(root);
    at(scope(LOCAL, ALICE));

    const listed = await store.list();
    expect(listed.map(entry => entry.id)).toEqual(['legacy-one']);
    expect(listed[0]).toMatchObject({ title: 'from before scoping', model: 'old-model', messageCount: 1 });

    const session = await store.get('legacy-one');
    expect(session?.messages[0]?.content).toBe('still here');
    // Moved, not copied: the loose file is gone and the scope holds the only one.
    expect((await readdir(root)).filter(name => name.endsWith('.json'))).toEqual([]);
    expect(
      (await readdir(join(root, sessionScopeKey(scope(LOCAL, ALICE))))).filter(name => name.endsWith('.json'))
    ).toEqual(['legacy-one.json']);
  });

  it('migrates the whole directory, byte for byte', async () => {
    const bodies = new Map<string, string>();
    for (const id of ['a', 'b', 'c', 'd']) {
      const body = JSON.stringify({ id, title: id, messages: [{ id: 'm', role: 'user', content: id }] }, null, 2);
      bodies.set(id, body);
      await writeFile(join(root, `${id}.json`), body, 'utf8');
    }

    const { store, at } = scopedStore(root);
    at(scope(LOCAL, ALICE));
    expect((await store.list()).map(entry => entry.id).sort()).toEqual(['a', 'b', 'c', 'd']);

    const destination = join(root, sessionScopeKey(scope(LOCAL, ALICE)));
    for (const [id, body] of bodies) {
      expect(await readFile(join(destination, `${id}.json`), 'utf8')).toBe(body);
    }
  });

  it('runs once, so a later environment does not inherit them a second time', async () => {
    await writeLegacy('legacy-one', { id: 'legacy-one', title: 'only mine', messages: [] });

    const { store, at } = scopedStore(root);
    at(scope(LOCAL, ALICE));
    expect((await store.list()).map(entry => entry.id)).toEqual(['legacy-one']);

    at(scope(HOSTED, ALICE));
    expect(await store.list()).toEqual([]);

    at(scope(LOCAL, ALICE));
    expect((await store.list()).map(entry => entry.id)).toEqual(['legacy-one']);
  });

  it('survives the relaunch that finds the migration already done', async () => {
    await writeLegacy('legacy-one', { id: 'legacy-one', title: 'only mine', messages: [] });

    const first = scopedStore(root);
    first.at(scope(LOCAL, ALICE));
    await first.store.list();

    const second = scopedStore(root);
    second.at(scope(LOCAL, ALICE));
    expect((await second.store.list()).map(entry => entry.id)).toEqual(['legacy-one']);
  });

  it('leaves the loose files alone until there is an account to give them to', async () => {
    await writeLegacy('legacy-one', { id: 'legacy-one', title: 'only mine', messages: [] });

    const { store, at } = scopedStore(root);
    at(null);
    expect(await store.list()).toEqual([]);
    expect(await readdir(root)).toEqual(['legacy-one.json']);
  });
});

describe('SessionStore device-local conversations', () => {
  const signedOut: AuthState = {
    status: 'signed-out',
    environment: { preset: 'hosted', url: HOSTED, label: 'Hosted' },
    hostedAvailable: true,
    storage: 'available',
    busy: 'idle',
  };

  it('creates and lists fresh signed-out chats, with account and device storage isolated across switches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b4m-device-local-'));
    let auth = signedOut;
    const store = new SessionStore(root, MODEL, 'launch', () => sessionScopeForChat(auth));
    const local = await store.create('local:llama');
    expect((await store.list()).map(session => session.id)).toEqual([local.id]);
    expect(await readdir(root)).toEqual(['device-local']);
    auth = { ...signedOut, status: 'signed-in', user: { id: ALICE } };
    expect(await store.list()).toEqual([]);
    expect(await store.get(local.id)).toBeNull();
    const hosted = await store.create();
    auth = signedOut;
    expect((await store.list()).map(session => session.id)).toEqual([local.id]);
    expect(await store.get(hosted.id)).toBeNull();
    const relaunched = new SessionStore(root, MODEL, 'new-launch', () => sessionScopeForChat(auth));
    expect((await relaunched.list()).map(session => session.id)).toEqual([local.id]);
  });

  it('never adopts loose legacy account transcripts into the signed-out device namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b4m-device-legacy-'));
    await writeFile(join(root, 'legacy.json'), JSON.stringify({ id: 'legacy', title: 'private', messages: [] }));
    let auth = signedOut;
    const store = new SessionStore(root, MODEL, 'launch', () => sessionScopeForChat(auth));
    expect(await store.list()).toEqual([]);
    expect(await store.get('legacy')).toBeNull();
    await store.create('local:llama');
    expect(await readdir(root)).toContain('legacy.json');
    auth = { ...signedOut, status: 'signed-in', user: { id: ALICE } };
    expect((await store.list()).map(session => session.id)).toEqual(['legacy']);
  });
});

describe('import', () => {
  function imported(id: string, title: string): ChatSession {
    const at = '2026-01-01T00:00:00.000Z';
    return {
      id,
      title,
      model: 'm',
      createdAt: at,
      updatedAt: at,
      mode: 'chat',
      approvalMode: 'ask',
      reasoningEffort: 'default',
      importOrigin: { kind: 'claude-chat', sourceId: id, importedAt: at, sourceUpdatedAt: at },
      messages: [{ id: `cl-${id}-1`, role: 'user', content: 'hello', createdAt: at }],
    };
  }

  describe('SessionStore imports', () => {
    it('writes, replaces, and keeps the user row choices across a re-sync', async () => {
      const store = new SessionStore(await mkdtemp(join(tmpdir(), 'store-import-')), 'default');
      expect(await store.putImported(imported('cl-a', 'First'))).toBe('written');
      await store.setPinned('cl-a', true);
      await store.rename('cl-a', 'My name');
      expect(await store.putImported({ ...imported('cl-a', 'Upstream name'), messages: [] })).toBe('written');
      const session = (await store.get('cl-a'))!;
      expect(session).toMatchObject({ title: 'My name', pinned: true, messages: [] });
      expect(session.importOrigin).toMatchObject({ kind: 'claude-chat', sourceId: 'cl-a' });
    });

    it('marks a session forked on the first desktop message, and refuses to overwrite it after', async () => {
      const store = new SessionStore(await mkdtemp(join(tmpdir(), 'store-import-')), 'default');
      await store.putImported(imported('cl-b', 'Imported'));
      await store.appendMessage('cl-b', { id: 'cl-b-2', role: 'user', content: 'still imported', createdAt: 'x' });
      expect((await store.get('cl-b'))!.importOrigin!.forkedAt).toBeUndefined();
      await store.appendMessage('cl-b', { id: 'desktop', role: 'user', content: 'mine', createdAt: 'x' });
      expect((await store.get('cl-b'))!.importOrigin!.forkedAt).toBeTruthy();

      expect(await store.putImported(imported('cl-b', 'Overwrite attempt'))).toBe('forked');
      expect((await store.get('cl-b'))!.messages.at(-1)!.content).toBe('mine');
    });

    it('never replaces a session that was not imported', async () => {
      const store = new SessionStore(await mkdtemp(join(tmpdir(), 'store-import-')), 'default');
      const own = await store.create();
      expect(await store.putImported(imported(own.id, 'Collision'))).toBe('forked');
      expect((await store.get(own.id))!.importOrigin).toBeUndefined();
    });

    it('lists from the summary index without re-reading files whose size and mtime are unchanged', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'store-index-'));
      const store = new SessionStore(directory, 'default');
      await store.putImported(imported('cl-c', 'Original'));
      const path = join(directory, 'cl-c.json');
      const fixed = new Date('2026-01-01T00:00:00.000Z');
      await utimes(path, fixed, fixed);
      expect((await store.list()).map(session => session.title)).toEqual(['Original']);

      // Same length, same mtime: the index answers and the edit is not seen.
      await writeFile(path, (await readFile(path, 'utf8')).replace('Original', 'Replaced'));
      await utimes(path, fixed, fixed);
      const fresh = new SessionStore(directory, 'default');
      expect((await fresh.list()).map(session => session.title)).toEqual(['Original']);

      // A real write changes the mtime, so it is re-read.
      await fresh.rename('cl-c', 'Renamed');
      expect((await fresh.list()).map(session => session.title)).toEqual(['Renamed']);

      // A deleted file drops out of the listing and the index.
      await fresh.delete('cl-c');
      expect(await fresh.list()).toEqual([]);
    });

    it('ignores an index built under different launch defaults', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'store-index-'));
      const first = new SessionStore(directory, 'model-one');
      const created = await first.create();
      await writeFile(
        join(directory, `${created.id}.json`),
        JSON.stringify({ ...(await first.get(created.id)), model: '' })
      );
      expect((await first.list())[0].model).toBe('model-one');
      const second = new SessionStore(directory, 'model-two');
      expect((await second.list())[0].model).toBe('model-two');
    });

    it('refuses an import whose account is no longer the one signed in', async () => {
      const alice: SessionScope = { environmentUrl: 'http://localhost:3000', accountId: 'account-alice' };
      const bob: SessionScope = { environmentUrl: 'http://localhost:3000', accountId: 'account-bob' };
      let current: SessionScope | null = alice;
      const store = new SessionStore(
        await mkdtemp(join(tmpdir(), 'store-import-')),
        'default',
        'launch',
        () => current
      );
      const started = sessionScopeKey(alice);
      expect(await store.putImported(imported('cl-d', 'Hers'), started)).toBe('written');

      current = bob;
      await expect(store.putImported(imported('cl-e', 'Also hers'), started)).rejects.toBeInstanceOf(
        ImportScopeChangedError
      );
      await expect(store.getImported('cl-d', started)).rejects.toBeInstanceOf(ImportScopeChangedError);
      expect(await store.list()).toEqual([]);
      current = null;
      await expect(store.putImported(imported('cl-e', 'Also hers'), started)).rejects.toBeInstanceOf(
        ImportScopeChangedError
      );
      current = alice;
      expect((await store.list()).map(session => session.id)).toEqual(['cl-d']);
    });

    it('keeps what the user set on an imported session that the import does not', async () => {
      const store = new SessionStore(await mkdtemp(join(tmpdir(), 'store-import-')), 'default');
      await store.putImported(imported('cl-f', 'First'));
      await store.addGrantedDirectory('cl-f', '/work/granted');
      await store.putImported({ ...imported('cl-f', 'Second'), messages: [] });
      expect((await store.get('cl-f'))!).toMatchObject({ title: 'Second', grantedDirectories: ['/work/granted'] });
    });

    it('keeps the per-chat generation overrides over what a re-sync carries', async () => {
      const store = new SessionStore(await mkdtemp(join(tmpdir(), 'store-import-')), 'default');
      await store.putImported(imported('cl-g', 'First'));
      await store.setGeneration('cl-g', { temperature: 0.3 });
      await store.putImported({ ...imported('cl-g', 'Second'), generation: { temperature: 1.5 } });
      expect((await store.get('cl-g'))!.generation).toEqual({ temperature: 0.3 });
    });
    it('does not recreate a copy deleted after the importer read it', async () => {
      const store = new SessionStore(await mkdtemp(join(tmpdir(), 'store-import-')), 'default');
      await store.putImported(imported('cl-race', 'Original'));
      const snapshot = (await store.getImported('cl-race'))!;
      await store.delete('cl-race');
      expect(await store.putImported(snapshot, undefined, { mustExist: true })).toBe('removed');
      expect(await store.get('cl-race')).toBeNull();
    });

    it('checks continuation inside the guarded removal instead of trusting an earlier summary', async () => {
      const store = new SessionStore(await mkdtemp(join(tmpdir(), 'store-import-')), 'default');
      await store.putImported(imported('cl-remove', 'Original'));
      const snapshot = (await store.list())[0];
      expect(snapshot.importOrigin?.forkedAt).toBeUndefined();
      await store.appendMessage('cl-remove', { id: 'desktop-turn', role: 'user', content: 'keep me', createdAt: 'x' });
      expect(await store.deleteImported('cl-remove', 'unused-unscoped-key')).toBe('forked');
      expect((await store.get('cl-remove'))?.messages.at(-1)?.content).toBe('keep me');
      expect(await store.deleteImported('missing', 'unused-unscoped-key')).toBe('missing');
      await store.putImported(imported('cl-uncontinued', 'Original'));
      expect(await store.deleteImported('cl-uncontinued', 'unused-unscoped-key')).toBe('removed');
      expect(await store.get('cl-uncontinued')).toBeNull();
    });

    it('refuses guarded removal after the account has changed', async () => {
      const alice: SessionScope = { environmentUrl: 'http://localhost:3000', accountId: 'account-alice' };
      const bob: SessionScope = { environmentUrl: 'http://localhost:3000', accountId: 'account-bob' };
      let current: SessionScope = alice;
      const store = new SessionStore(
        await mkdtemp(join(tmpdir(), 'store-import-')),
        'default',
        'launch',
        () => current
      );
      const aliceKey = sessionScopeKey(alice);
      await store.putImported(imported('cl-shared', 'Alice'), aliceKey);
      current = bob;
      await store.putImported(imported('cl-shared', 'Bob'), sessionScopeKey(bob));
      await expect(store.deleteImported('cl-shared', aliceKey)).rejects.toBeInstanceOf(ImportScopeChangedError);
      expect((await store.get('cl-shared'))?.title).toBe('Bob');
      current = alice;
      expect((await store.get('cl-shared'))?.title).toBe('Alice');
    });
  });
});

describe('workspace owners', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-workspace-owners-'));
    roots.push(directory);
    const project: ChatProject = {
      directory,
      name: 'Project',
      branch: 'main',
      workspace: true,
      workspaceBranch: 'b4m/task-abc123',
      workingDirectory: join(directory, 'checkout'),
      contextDirectories: [join(directory, 'reference')],
    };
    const sessions = join(directory, 'sessions');
    const scoped = (accountId: string, environmentUrl = 'http://localhost:3000') =>
      new SessionStore(sessions, 'model', 'launch', () => ({ accountId, environmentUrl }));
    return { directory, project, sessions, scoped };
  }

  describe('SessionStore workspace owners', () => {
    it('preserves foreign account, environment and local bindings without exposing their titles', async () => {
      const { project, sessions, scoped } = await fixture();
      const current = scoped('current');
      await current.create(undefined, { project, title: 'Current title' });
      await scoped('other').create(undefined, { project, title: 'Private account title' });
      await scoped('current', 'http://localhost:4000').create(undefined, {
        project,
        title: 'Private environment title',
      });
      await new SessionStore(sessions, 'model').create(undefined, { project, title: 'Private local title' });

      const owners = await current.workspaceOwnersExcept('');
      expect(owners).toHaveLength(4);
      expect(owners.map(owner => owner.title).sort()).toEqual([
        'Another conversation',
        'Another conversation',
        'Another conversation',
        'Current title',
      ]);
      for (const owner of owners) {
        expect(owner.project).toEqual(project);
        expect(owner.directories).toEqual([project.directory, project.workingDirectory, ...project.contextDirectories]);
      }
    });

    it('includes grants from a projectless conversation and excludes only the requested session', async () => {
      const { directory, scoped } = await fixture();
      const store = scoped('current');
      const first = await store.create(undefined, { title: 'Reference', grantedDirectories: [directory] });
      const excluded = await store.create(undefined, { title: 'Excluded', grantedDirectories: [directory] });
      const owners = await store.workspaceOwnersExcept(excluded.id);
      expect(owners).toEqual([{ title: 'Reference', directories: [directory] }]);
      expect(await store.workspaceProjectsExcept(excluded.id)).toEqual([]);
      expect((await store.get(first.id))?.grantedDirectories).toEqual([directory]);
    });

    it('calls an owner with no usable title by the untitled name rather than failing the scan', async () => {
      const { project, sessions, scoped } = await fixture();
      const store = scoped('current');
      const session = await store.create(undefined, { project });
      const file = join(sessions, store.scopeKey()!, `${session.id}.json`);
      await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), title: null }));

      expect((await store.workspaceOwnersExcept('')).map(owner => owner.title)).toEqual(['New chat']);
    });

    it('fails closed on malformed grants instead of treating the checkout as unowned', async () => {
      const { sessions, scoped } = await fixture();
      const store = scoped('current');
      const session = await store.create();
      await writeFile(
        join(sessions, store.scopeKey()!, `${session.id}.json`),
        JSON.stringify({ grantedDirectories: [42] })
      );
      await expect(store.workspaceOwnersExcept('')).rejects.toThrow();
    });
  });
});
