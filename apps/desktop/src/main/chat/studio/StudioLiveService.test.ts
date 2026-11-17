import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioDraft } from '@shared/studioIpc';
import { SessionStore } from '../SessionStore';
import { AttachmentStore } from '../AttachmentStore';
import type { SessionScope } from '../sessionScope';
import { StudioWorkspaceStore } from './StudioWorkspaceStore';
import { StudioLiveService } from './StudioLiveService';

describe('Studio live orchestration', () => {
  let directory: string;
  let scope: SessionScope | null;
  let sessions: SessionStore;
  let live: StudioLiveService;
  const submit = vi.fn();
  const prepare = vi.fn(async () => 'Prepared prompt');
  const changed = vi.fn();
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'studio-live-'));
    scope = { environmentUrl: 'https://example.com', accountId: 'first' };
    sessions = new SessionStore(join(directory, 'sessions'), 'model', 'test', () => scope);
    live = new StudioLiveService({
      sessions,
      workspaces: new StudioWorkspaceStore(join(directory, 'studio'), sessions),
      attachments: new AttachmentStore(join(directory, 'attachments'), { debug() {}, warn() {} }),
      roots: async () => [directory],
      prepare,
      changed,
      available: () => true,
      generation: { submit, recover: async () => [] },
    });
  });
  afterEach(async () => {
    live.invalidate();
    vi.clearAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  async function draft(): Promise<StudioDraft> {
    const session = await sessions.create();
    const state = await live.get(session.id);
    return {
      sessionId: session.id,
      workspaceId: state.workspace.workspaceId,
      revision: state.revision,
      kind: 'image',
      prompt: 'A landscape',
      selection: { mode: 'current-session' },
      settings: {},
    };
  }
  it('shares the persisted workspace between parent and child', async () => {
    const parent = await sessions.create();
    const child = await sessions.create(undefined, {
      origin: { parentSessionId: parent.id, depth: 1, seedPrompt: '' },
    });
    expect((await live.get(parent.id)).workspace.workspaceId).toBe((await live.get(child.id)).workspace.workspaceId);
  });
  it('requires a single-use main-owned review and preserves edited output', async () => {
    const input = await draft();
    const review = await live.prepare(input);
    const request = { draft: input, reviewId: review.id, preparedPrompt: 'Edited prompt' };
    await live.create(request);
    expect(submit).toHaveBeenCalledWith(
      input.sessionId,
      input,
      'Edited prompt',
      expect.objectContaining({ sessions: expect.any(Array) }),
      expect.any(Function)
    );
    await expect(live.create(request)).rejects.toThrow('Review expired');
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('rejects changes to reviewed settings', async () => {
    const input = await draft();
    const review = await live.prepare(input);
    await expect(
      live.create({
        draft: { ...input, settings: { size: '1024x1024' } },
        reviewId: review.id,
        preparedPrompt: review.preparedPrompt,
      })
    ).rejects.toThrow('Review expired');
    expect(submit).not.toHaveBeenCalled();
  });
  it('rejects history changes after preparation', async () => {
    const input = await draft();
    const review = await live.prepare(input);
    await sessions.appendMessage(input.sessionId, {
      id: 'new-message',
      role: 'user',
      content: 'New context',
      createdAt: new Date().toISOString(),
    });
    await expect(
      live.create({ draft: input, reviewId: review.id, preparedPrompt: review.preparedPrompt })
    ).rejects.toThrow('Context changed');
    expect(submit).not.toHaveBeenCalled();
  });
  it('rejects account changes and invalidates pending preparation', async () => {
    const input = await draft();
    prepare.mockImplementationOnce(async () => {
      scope = { environmentUrl: 'https://example.com', accountId: 'second' };
      return 'Wrong account';
    });
    await expect(live.prepare(input)).rejects.toThrow('scope changed');
    expect(submit).not.toHaveBeenCalled();
  });
  it('rejects malformed IPC payloads before reading or preparing', async () => {
    await expect(live.prepare({ sessionId: '../escape' })).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
  });
});
