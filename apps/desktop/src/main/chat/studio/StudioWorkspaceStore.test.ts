import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioAsset, StudioJob } from '@shared/studio';
import { SessionStore } from '../SessionStore';
import { sessionScopeKey, type SessionScope } from '../sessionScope';
import { StudioWorkspaceStore } from './StudioWorkspaceStore';

const ALICE = { environmentUrl: 'https://example.com', accountId: 'alice' };

describe('Studio workspace persistence', () => {
  let root: string;
  let scope: SessionScope | null;
  let sessions: SessionStore;
  let workspaces: StudioWorkspaceStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'studio-'));
    scope = ALICE;
    sessions = new SessionStore(join(root, 'sessions'), 'model', 'launch', () => scope);
    workspaces = new StudioWorkspaceStore(join(root, 'studio'), sessions);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function asset(sessionId: string, id = 'asset-one'): StudioAsset {
    return {
      id,
      kind: 'image',
      title: id,
      originatingSessionId: sessionId,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      url: 'b4m-media://image.png',
    };
  }

  it('retains orphaned workspace outputs for 30 days and cleans only the active account', async () => {
    const session = await sessions.create();
    await workspaces.upsertAsset(session.id, asset(session.id));
    const identity = await sessions.resolveStudioWorkspace(session.id);
    await sessions.delete(session.id);
    const removeMedia = vi.fn(async () => undefined);
    await workspaces.pruneOrphans(new Set(), removeMedia);
    expect(removeMedia).not.toHaveBeenCalled();
    const marker = join(root, 'studio', sessionScopeKey(ALICE), identity!.workspaceId, '.orphaned-at');
    await writeFile(marker, String(Date.now() - 31 * 24 * 60 * 60_000));
    await workspaces.pruneOrphans(new Set(), removeMedia);
    expect(removeMedia).toHaveBeenCalledWith(identity!.workspaceId, 'asset-one');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  async function legacy(id: string, parent?: string) {
    await sessions.create();
    await writeFile(
      join(root, 'sessions', sessionScopeKey(ALICE), `${id}.json`),
      JSON.stringify({
        id,
        messages: [],
        ...(parent ? { origin: { parentSessionId: parent, depth: 1, seedPrompt: '' } } : {}),
      })
    );
  }

  it('inherits one identity through children, side chats and deeper descendants after restart', async () => {
    const parent = await sessions.create();
    const child = await sessions.create(undefined, {
      origin: { parentSessionId: parent.id, depth: 1, seedPrompt: '', kind: 'side-chat' },
    });
    const grandchild = await sessions.create(undefined, {
      origin: { parentSessionId: child.id, depth: 2, seedPrompt: '' },
    });
    const unrelated = await sessions.create();
    const expected = await sessions.resolveStudioWorkspace(parent.id);
    expect(await sessions.resolveStudioWorkspace(child.id)).toEqual(expected);
    expect(await sessions.resolveStudioWorkspace(grandchild.id)).toEqual(expected);
    expect(await sessions.resolveStudioWorkspace(unrelated.id)).not.toEqual(expected);
    const relaunched = new SessionStore(join(root, 'sessions'), 'model', 'relaunch', () => scope);
    expect(await relaunched.resolveStudioWorkspace(grandchild.id)).toEqual(expected);
    expect((await relaunched.get(child.id))?.studioWorkspaceId).toBe(expected?.workspaceId);
  });

  it('keeps shared ownership and records after parent deletion without reviving deleted sessions', async () => {
    const parent = await sessions.create();
    const child = await sessions.create(undefined, {
      origin: { parentSessionId: parent.id, depth: 1, seedPrompt: '' },
    });
    await workspaces.upsertAsset(parent.id, asset(parent.id));
    const identity = await sessions.resolveStudioWorkspace(parent.id);
    await sessions.delete(parent.id);
    expect(await sessions.resolveStudioWorkspace(child.id)).toEqual(identity);
    expect((await workspaces.get(child.id))?.assets).toHaveLength(1);
    expect(await workspaces.upsertAsset(parent.id, asset(parent.id, 'late'))).toBe(false);
    expect(await workspaces.get(parent.id)).toBeNull();
  });

  it('resolves legacy families lazily and does not parse transcripts on subsequent listings', async () => {
    await legacy('parent');
    await legacy('child', 'parent');
    await legacy('grandchild', 'child');
    const expected = await sessions.resolveStudioWorkspace('parent');
    expect(await sessions.resolveStudioWorkspace('grandchild')).toEqual(expected);
    await workspaces.upsertAsset('child', asset('child'));
    await writeFile(join(root, 'sessions', sessionScopeKey(ALICE), 'child.json'), 'not JSON');
    expect((await workspaces.listAssets('child'))?.items).toHaveLength(1);
    await sessions.delete('parent');
    expect(await sessions.resolveStudioWorkspace('grandchild')).toEqual(expected);
  });

  it('anchors orphan siblings to their missing ancestor and rejects cycles and path traversal', async () => {
    await legacy('child', 'missing-parent');
    await legacy('sibling', 'missing-parent');
    expect(await sessions.resolveStudioWorkspace('child')).toEqual(await sessions.resolveStudioWorkspace('sibling'));
    await legacy('cycle-one', 'cycle-two');
    await legacy('cycle-two', 'cycle-one');
    expect(await sessions.resolveStudioWorkspace('cycle-one')).toBeNull();
    await legacy('unsafe', '../escape');
    expect(await sessions.resolveStudioWorkspace('unsafe')).toBeNull();
    await expect(sessions.resolveStudioWorkspace('../escape')).rejects.toThrow();
    expect(await sessions.resolveStudioWorkspace('absent')).toBeNull();
  });

  it('isolates accounts, environments, sign-out and stale scope submissions', async () => {
    const session = await sessions.create();
    await workspaces.upsertAsset(session.id, asset(session.id));
    const originalScope = sessions.scopeKey();
    for (const next of [
      { ...ALICE, accountId: 'bob' },
      { ...ALICE, environmentUrl: 'https://elsewhere.example.com' },
      null,
    ]) {
      scope = next;
      expect(await workspaces.get(session.id)).toBeNull();
      expect(await workspaces.upsertAsset(session.id, asset(session.id), originalScope)).toBe(false);
    }
    scope = ALICE;
    expect((await workspaces.get(session.id))?.assets).toHaveLength(1);
  });

  it('preserves concurrent assets and jobs across store instances and paginates bounded records', async () => {
    const session = await sessions.create();
    const otherSessions = new SessionStore(join(root, 'sessions'), 'model', 'other-launch', () => scope);
    const other = new StudioWorkspaceStore(join(root, 'studio'), otherSessions);
    await Promise.all(
      Array.from({ length: 105 }, (_, index) => {
        const target = index % 2 ? other : workspaces;
        return target.upsertAsset(session.id, asset(session.id, `asset-${String(index).padStart(3, '0')}`));
      })
    );
    const job: StudioJob = {
      id: 'job',
      kind: 'video',
      originatingSessionId: session.id,
      state: 'queued',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      idempotencyKey: 'request',
      assetIds: [],
    };
    await Promise.all([
      workspaces.upsertJob(session.id, job),
      other.upsertAsset(session.id, asset(session.id, 'last')),
    ]);
    const first = await workspaces.listAssets(session.id);
    expect(first?.items).toHaveLength(100);
    const second = await other.listAssets(session.id, { cursor: first?.nextCursor });
    expect(second?.items).toHaveLength(6);
    expect(second?.nextCursor).toBeUndefined();
    expect((await workspaces.listJobs(session.id))?.items).toEqual([job]);
    await expect(workspaces.listAssets(session.id, { limit: 101 })).rejects.toThrow();
    expect(await workspaces.get(session.id)).toMatchObject({
      assets: first?.items,
      nextAssetCursor: first?.nextCursor,
    });
    await workspaces.removeAsset(session.id, 'last');
    expect((await other.listAssets(session.id, { cursor: 'asset-104' }))?.items).toEqual([]);
  });

  it('rejects unrelated asset owners and keeps remote notebook identities independent', async () => {
    const first = await sessions.create();
    const second = await sessions.create();
    expect(await workspaces.upsertAsset(first.id, asset(second.id))).toBe(false);
    const stored = JSON.parse(
      await readFile(join(root, 'sessions', sessionScopeKey(ALICE), `${first.id}.json`), 'utf8')
    );
    expect(stored.studioWorkspaceId).toBe(first.id);
    expect(stored.remoteSessionId).toBeUndefined();
  });

  it('does not publish a write when the account switches during ownership resolution', async () => {
    const session = await sessions.create();
    const resolve = sessions.resolveStudioWorkspace.bind(sessions);
    let calls = 0;
    vi.spyOn(sessions, 'resolveStudioWorkspace').mockImplementation(async (...args) => {
      const result = await resolve(...args);
      if (++calls === 2) scope = { ...ALICE, accountId: 'bob' };
      return result;
    });
    expect(await workspaces.upsertAsset(session.id, asset(session.id))).toBe(false);
    scope = ALICE;
    expect((await workspaces.get(session.id))?.assets).toEqual([]);
  });

  it('orders session deletion after an in-flight write and refuses later writes', async () => {
    const session = await sessions.create();
    let release = () => {};
    const paused = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered = () => {};
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const resolve = sessions.resolveStudioWorkspace.bind(sessions);
    vi.spyOn(sessions, 'resolveStudioWorkspace').mockImplementationOnce(async (...args) => {
      entered();
      await paused;
      return resolve(...args);
    });
    const writing = workspaces.upsertAsset(session.id, asset(session.id));
    await started;
    const deleting = sessions.delete(session.id);
    release();
    expect(await writing).toBe(true);
    await deleting;
    expect(await workspaces.upsertAsset(session.id, asset(session.id, 'late'))).toBe(false);
  });

  it('shares a legacy missing-parent identity with newly created siblings', async () => {
    await legacy('orphan', 'missing-parent');
    const identity = await sessions.resolveStudioWorkspace('orphan');
    const sibling = await sessions.create(undefined, {
      origin: { parentSessionId: 'missing-parent', depth: 1, seedPrompt: '' },
    });
    expect(await sessions.resolveStudioWorkspace(sibling.id)).toEqual(identity);
  });

  it('paginates prefix IDs in the same order used by cursors', async () => {
    const session = await sessions.create();
    await workspaces.upsertAsset(session.id, asset(session.id, 'a'));
    await workspaces.upsertAsset(session.id, asset(session.id, 'a-1'));
    const first = await workspaces.listAssets(session.id, { limit: 1 });
    expect(first?.items.map(item => item.id)).toEqual(['a']);
    const second = await workspaces.listAssets(session.id, { limit: 1, cursor: first?.nextCursor });
    expect(second?.items.map(item => item.id)).toEqual(['a-1']);
    expect(second?.nextCursor).toBeUndefined();
  });
});
