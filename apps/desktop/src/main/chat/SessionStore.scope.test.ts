import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from './SessionStore';
import { sessionScopeKey, sessionScopeForChat, type SessionScope } from './sessionScope';
import type { AuthState } from '@shared/auth';

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
