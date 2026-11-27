import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageModels } from '@bike4mind/common';
import { ChatService } from '../ChatService';
import { SessionStore } from '../SessionStore';
import { AttachmentStore } from '../AttachmentStore';
import { AccessStore } from '../tools/AccessStore';
import { MediaStore } from '../media/MediaStore';
import type { MediaApiClient } from '../media/MediaApiClient';
import { sessionScopeKey } from '../sessionScope';
import { StudioWorkspaceStore } from './StudioWorkspaceStore';
import { StudioLiveService } from './StudioLiveService';
import { StudioGenerationService, type StudioGenerationRequest } from './generation/StudioGenerationService';
import { createStudioSessionDeletion } from './StudioSessionDeletion';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const request: StudioGenerationRequest = {
  kind: 'image',
  body: { mode: 'generate', model: ImageModels.GPT_IMAGE_2, prompt: 'a garden' },
};
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'studio-delete-'));
  roots.push(root);
  let account = { environmentUrl: 'https://example.test', accountId: 'a' };
  const sessions = new SessionStore(join(root, 'sessions'), 'model', 'launch', () => account);
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const attachments = new AttachmentStore(join(root, 'attachments'), logger);
  const workspaces = new StudioWorkspaceStore(join(root, 'studio'), sessions);
  const media = new MediaStore(join(root, 'media'));
  const paid = vi.fn(async () => ({ group_id: 'group', data: [{ id: 'remote' }] }));
  const authorize = vi.fn(async () => true);
  const generation = new StudioGenerationService({
    workspaces,
    media,
    authorize,
    connection: () => ({
      scope: sessionScopeKey(account),
      client: { createImageJobGroup: paid } as unknown as MediaApiClient,
    }),
  });
  const live = new StudioLiveService({
    sessions,
    workspaces,
    attachments,
    roots: async () => [],
    prepare: async () => '',
    available: () => true,
    generation: {
      submit: async () => {
        throw new Error('Unused paid path');
      },
      recover: async () => [],
    },
    changed: () => {},
  });
  const chat = new ChatService({
    store: sessions,
    attachments,
    access: new AccessStore(join(root, 'access.json')),
    logger,
    getApiClient: () => null,
    getEnvironmentUrl: () => account.environmentUrl,
    emit: () => {},
  });
  chat.studioWithSessionDeletion = createStudioSessionDeletion(sessions, live, generation);
  const parent = await sessions.create();
  return {
    sessions,
    generation,
    chat,
    parent,
    workspaces,
    paid,
    authorize,
    attachments,
    switchAccount: () => {
      account = { ...account, accountId: 'b' };
    },
  };
}
function observeSecondGate(generation: StudioGenerationService) {
  const second = Promise.withResolvers<void>();
  const original = generation.withWorkspaceLock.bind(generation);
  let count = 0;
  let firstFinished = false;
  vi.spyOn(generation, 'withWorkspaceLock').mockImplementation((scope, workspace, operation) => {
    if (++count === 2) second.resolve();
    const result = original(scope, workspace, operation);
    if (count === 1)
      void result.then(
        () => {
          firstFinished = true;
        },
        () => {
          firstFinished = true;
        }
      );
    return result;
  });
  return Object.assign(second.promise, { firstFinished: () => firstFinished });
}
function holdDeletion(sessions: SessionStore) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = sessions.delete.bind(sessions);
  vi.spyOn(sessions, 'delete').mockImplementationOnce(async (id, expectedScope) => {
    entered.resolve();
    await release.promise;
    await original(id, expectedScope);
  });
  return { entered: entered.promise, release: () => release.resolve() };
}

describe('Studio family deletion and admission', () => {
  it('retains the last family owner when two deletions overlap', async () => {
    const { sessions, generation, chat, parent, workspaces } = await setup();
    const child = await sessions.create(undefined, {
      origin: { parentSessionId: parent.id, depth: 1, seedPrompt: '' },
    });
    const job = await generation.submit(parent.id, request);
    const secondGate = observeSecondGate(generation);
    const held = holdDeletion(sessions);
    const first = chat.deleteSession(parent.id);
    await held.entered;
    const gateReleasedBeforeStorage = secondGate.firstFinished();
    const second = chat.deleteSession(child.id).then(
      () => 'removed',
      (error: unknown) => error
    );
    await secondGate;
    held.release();
    await first;
    expect(gateReleasedBeforeStorage).toBe(false);
    expect(await second).toMatchObject({ message: expect.stringContaining('last session') });
    expect(await sessions.get(parent.id)).toBeNull();
    expect(await sessions.get(child.id)).not.toBeNull();
    expect((await workspaces.getJob(child.id, job.id))?.providerJobId).toBe('remote');
  });

  it('does not admit a paid request after deletion wins the gate', async () => {
    const { sessions, generation, chat, parent, paid } = await setup();
    const secondGate = observeSecondGate(generation);
    const held = holdDeletion(sessions);
    const deleting = chat.deleteSession(parent.id);
    await held.entered;
    const submitting = generation.submit(parent.id, request).catch((error: unknown) => error);
    await secondGate;
    held.release();
    await deleting;
    expect(await submitting).toBeInstanceOf(Error);
    expect(paid).not.toHaveBeenCalled();
    expect(await sessions.get(parent.id)).toBeNull();
  });

  it('retains the captured account while waiting for a worktree lease', async () => {
    const { sessions, chat, parent, switchAccount } = await setup();
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lease = sessions.withWorkspaceBindings(async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const entered = Promise.withResolvers<void>();
    const original = sessions.withWorkspaceBindings.bind(sessions);
    vi.spyOn(sessions, 'withWorkspaceBindings').mockImplementation(operation => {
      entered.resolve();
      return original(operation);
    });
    const deleting = chat.deleteSession(parent.id, true).catch((error: unknown) => error);
    await entered.promise;
    switchAccount();
    const accountB = await sessions.create();
    const get = vi.spyOn(sessions, 'get');
    release.resolve();
    await lease;
    expect(await deleting).toMatchObject({ message: 'Account changed.' });
    expect(get).not.toHaveBeenCalled();
    expect(await sessions.get(accountB.id)).not.toBeNull();
  });

  it('keeps imported cleanup bound to the account that removed the stored record', async () => {
    const { sessions, chat, parent, switchAccount, attachments } = await setup();
    const source = (await sessions.get(parent.id))!;
    const imported = {
      ...source,
      id: 'imported',
      importOrigin: { kind: 'claude-code' as const, sourceId: 'source', importedAt: 'now', sourceUpdatedAt: 'now' },
    };
    const originalScope = sessions.scopeKey()!;
    await sessions.putImported(imported, originalScope);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const original = sessions.deleteImported.bind(sessions);
    vi.spyOn(sessions, 'deleteImported').mockImplementationOnce(async (id, scope) => {
      const outcome = await original(id, scope);
      entered.resolve();
      await finish.promise;
      return outcome;
    });
    const cleanup = vi.spyOn(attachments, 'deleteSession');
    const deleting = chat.deleteImportedSession(imported.id, originalScope).catch((error: unknown) => error);
    await entered.promise;
    switchAccount();
    await sessions.putImported({ ...imported, title: 'Account B copy' }, sessions.scopeKey()!);
    finish.resolve();
    expect(await deleting).toMatchObject({ message: 'Account changed.' });
    expect(cleanup).not.toHaveBeenCalled();
    expect((await sessions.get(imported.id))?.title).toBe('Account B copy');
  });

  it('waits for an admitted authorization before deciding the last session is deletable', async () => {
    const { generation, chat, parent, paid, authorize, sessions } = await setup();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<boolean>();
    authorize.mockImplementationOnce(() => {
      entered.resolve();
      return finish.promise;
    });
    const secondGate = observeSecondGate(generation);
    const submitting = generation.submit(parent.id, request);
    await entered.promise;
    const deleting = chat.deleteSession(parent.id).catch((error: unknown) => error);
    await secondGate;
    finish.resolve(true);
    expect((await submitting).state).toBe('queued');
    expect(await deleting).toMatchObject({ message: expect.stringContaining('last session') });
    expect(paid).toHaveBeenCalledTimes(1);
    expect(await sessions.get(parent.id)).not.toBeNull();
  });
});
