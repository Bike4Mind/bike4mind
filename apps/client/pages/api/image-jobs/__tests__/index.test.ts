// @vitest-environment node
/**
 * Route tests for POST /api/image-jobs (the chat image send). `baseApi` is stubbed (no auth chain) and the
 * repositories are fakes; the body validation, prompt rules, quest lifecycle and refusal mapping run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Mw = (req: unknown, res: unknown, next: () => void) => unknown;

const mocks = vi.hoisted(() => ({
  createImageJobs: vi.fn(),
  getCreateImageJobsDeps: vi.fn(),
  resolveMediaBillingOrgId: vi.fn(),
  assertAiAccessAllowed: vi.fn(),
  getOrCreateSession: vi.fn(),
  resolveImagePrompt: vi.fn(),
  resolveImageJobFiles: vi.fn(),
  quests: {
    getMostRecentChatHistory: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  fabFiles: { findAccessibleInIds: vi.fn() },
  generationJobs: { findById: vi.fn() },
  discardJobInputFiles: vi.fn(),
  canCreateFile: vi.fn(),
  copyGeneratedImageToFiles: vi.fn(),
  moderateFabFileNow: vi.fn(),
  broadcastChatImageQuest: vi.fn(),
  maybeSummarizeAfterChatImage: vi.fn(),
  nameNotebookAfterChatImage: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    let handlers: Mw[] = [];
    const dispatch = async (req: unknown, res: unknown) => {
      for (const handler of handlers) {
        let advanced = false;
        await handler(req, res, () => {
          advanced = true;
        });
        if (!advanced) return;
      }
    };
    return Object.assign(dispatch, {
      post: (...posted: Mw[]) => {
        handlers = posted;
        return dispatch;
      },
    });
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/perUserRateLimit', () => ({
  perUserRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/services/imageJobs', () => ({ createImageJobs: mocks.createImageJobs }));
vi.mock('@bike4mind/server-utils/generationJobs/wiring', () => ({
  getCreateImageJobsDeps: mocks.getCreateImageJobsDeps,
}));
vi.mock('@server/billing/resolveMediaBillingOrgId', () => ({
  resolveMediaBillingOrgId: mocks.resolveMediaBillingOrgId,
}));
vi.mock('@bike4mind/server-utils/auth/assertAiAccessAllowed', () => ({
  assertAiAccessAllowed: mocks.assertAiAccessAllowed,
}));
vi.mock('@bike4mind/server-utils/managers/sessionManager', () => ({ getOrCreateSession: mocks.getOrCreateSession }));
vi.mock('@server/managers/sessionOrigin', () => ({ resolveSessionOrigin: () => 'web' }));
vi.mock('@server/utils/resolveImagePrompt', () => ({
  HISTORY_LOOKBACK: 6,
  resolveImagePrompt: mocks.resolveImagePrompt,
}));
vi.mock('@bike4mind/server-utils/generations/resolveImageJobFiles', () => ({
  resolveImageJobFiles: mocks.resolveImageJobFiles,
}));
vi.mock('@bike4mind/database', () => ({
  FabFile: 'FabFile',
  questRepository: mocks.quests,
  fabFileRepository: mocks.fabFiles,
  generationJobRepository: mocks.generationJobs,
}));
vi.mock('@bike4mind/server-utils/generationJobs/discardJobInputFiles', () => ({
  discardJobInputFiles: mocks.discardJobInputFiles,
}));
vi.mock('@server/files/copyGeneratedImage', () => ({ copyGeneratedImageToFiles: mocks.copyGeneratedImageToFiles }));
vi.mock('@server/files/moderateFabFileNow', () => ({ moderateFabFileNow: mocks.moderateFabFileNow }));
vi.mock('@server/generations/chatImageQuestFollowUps', () => ({
  broadcastChatImageQuest: mocks.broadcastChatImageQuest,
  maybeSummarizeAfterChatImage: mocks.maybeSummarizeAfterChatImage,
  nameNotebookAfterChatImage: mocks.nameNotebookAfterChatImage,
}));

const { ForbiddenError, NotFoundError } = await import('@bike4mind/server-utils/utils/errors');

const { default: handler } = await import('../index');

const USER = { id: 'user-1', groups: [] };
const SESSION_ID = 'sess-1';
const SOURCE_ID = 'a'.repeat(24);
const MASK_ID = 'b'.repeat(24);
const ATTACHED_ID = 'c'.repeat(24);
const PRIOR_FILE_ID = 'd'.repeat(24);
const COPIED_FILE_ID = 'e'.repeat(24);
const LEGACY_KEY = 'generated-key.png';

const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
const call = async (body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: USER, logger, ability: { can: mocks.canCreateFile } });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() as Record<string, unknown> };
};

const job = (id: string) => ({ id, state: 'pending', payload: { groupId: 'group-1' } });
const generateBody = (extra: Record<string, unknown> = {}) => ({
  mode: 'generate',
  prompt: 'a lighthouse',
  sessionId: SESSION_ID,
  selection: { model: 'gpt-image-1.5', size: '1024x1024', quality: 'high' },
  ...extra,
});
const createInput = () => mocks.createImageJobs.mock.calls[0][0];

describe('POST /api/image-jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCreateImageJobsDeps.mockReturnValue({ deps: true });
    mocks.resolveMediaBillingOrgId.mockResolvedValue('org-1');
    mocks.getOrCreateSession.mockResolvedValue({
      sessionId: SESSION_ID,
      asyncPromises: [],
      session: { id: SESSION_ID, userId: USER.id, summary: 'a notebook about lighthouses' },
    });
    mocks.resolveImagePrompt.mockResolvedValue({ rewrittenPrompt: 'a red lighthouse at dusk', intent: 'fresh' });
    mocks.quests.getMostRecentChatHistory.mockResolvedValue([]);
    mocks.quests.create.mockImplementation(async (quest: Record<string, unknown>) => ({ ...quest, id: 'quest-1' }));
    mocks.quests.update.mockImplementation(async (patch: Record<string, unknown>) => ({
      ...patch,
      sessionId: SESSION_ID,
    }));
    mocks.fabFiles.findAccessibleInIds.mockResolvedValue([]);
    mocks.resolveImageJobFiles.mockResolvedValue([]);
    mocks.createImageJobs.mockResolvedValue({ ok: true, created: true, groupId: 'group-1', jobs: [job('j1')] });
    mocks.copyGeneratedImageToFiles.mockResolvedValue({ fileId: COPIED_FILE_ID, created: true });
    mocks.moderateFabFileNow.mockResolvedValue({ ok: true, moderationStatus: 'clean' });
    mocks.generationJobs.findById.mockResolvedValue(null);
    mocks.discardJobInputFiles.mockResolvedValue(undefined);
    mocks.canCreateFile.mockReturnValue(true);
  });

  it('creates a chat-made image job on a new quest and settles the quest with the job refs', async () => {
    const { status, body } = await call(generateBody({ count: 2, organizationId: 'org-1' }));

    expect(status).toBe(202);
    expect(mocks.quests.create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, prompt: 'a lighthouse', type: 'message' })
    );
    expect(createInput()).toMatchObject({
      user: { id: 'user-1', organizationId: 'org-1' },
      count: 2,
      source: 'agent',
      questId: 'quest-1',
      request: { model: 'gpt-image-1.5', mode: 'generate', prompt: 'a lighthouse', size: '1024x1024' },
    });
    expect(mocks.quests.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'quest-1', status: 'done', generationJobs: [{ id: 'j1', kind: 'image' }] }),
      { unset: ['errorCode', 'reply'] }
    );
    expect(body).toMatchObject({
      quest: { id: 'quest-1', status: 'done', generationJobs: [{ id: 'j1', kind: 'image' }] },
      originalPrompt: 'a lighthouse',
      enhancedPrompt: 'a lighthouse',
      promptWasEnhanced: false,
      intent: 'fresh',
      groupId: 'group-1',
      jobs: [{ id: 'j1', groupId: 'group-1', state: 'pending' }],
    });
  });

  it('sends the settled turn to the requester tabs and checks the notebook summary after a generation', async () => {
    await call(generateBody());

    expect(mocks.broadcastChatImageQuest).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ id: 'quest-1', status: 'done', generationJobs: [{ id: 'j1', kind: 'image' }] }),
      expect.anything()
    );
    expect(mocks.maybeSummarizeAfterChatImage).toHaveBeenCalledWith(
      expect.objectContaining({ id: SESSION_ID }),
      'user-1',
      expect.anything()
    );
    expect(mocks.nameNotebookAfterChatImage).toHaveBeenCalledWith(SESSION_ID, 'user-1', expect.anything());
  });

  it('neither sends nor summarises a send the job engine refused', async () => {
    mocks.createImageJobs.mockResolvedValue({ ok: false, status: 402, code: 'insufficient_credits', message: 'no' });
    await call(generateBody());
    expect(mocks.broadcastChatImageQuest).not.toHaveBeenCalled();
    expect(mocks.maybeSummarizeAfterChatImage).not.toHaveBeenCalled();
    expect(mocks.nameNotebookAfterChatImage).not.toHaveBeenCalled();
  });

  it('clamps the requested count to what one request may start', async () => {
    await call(generateBody({ count: 40 }));
    expect(createInput().count).toBe(4);
  });

  it('keeps a fresh prompt literal unless prompt enhancement is on', async () => {
    await call(generateBody());
    expect(createInput().request.prompt).toBe('a lighthouse');

    mocks.createImageJobs.mockClear();
    const { body } = await call(generateBody({ promptEnhancement: true }));
    expect(createInput().request.prompt).toBe('a red lighthouse at dusk');
    expect(body).toMatchObject({ enhancedPrompt: 'a red lighthouse at dusk', promptWasEnhanced: true });
    expect(mocks.quests.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: 'a lighthouse',
        promptEnhancement: {
          originalPrompt: 'a lighthouse',
          enhancedPrompt: 'a red lighthouse at dusk',
          promptWasEnhanced: true,
          intent: 'fresh',
        },
      })
    );
  });

  it('always rewrites a continuation and carries the newest job-made image forward as a reference', async () => {
    mocks.resolveImagePrompt.mockResolvedValue({ rewrittenPrompt: 'the lighthouse, at night', intent: 'continuation' });
    mocks.quests.getMostRecentChatHistory.mockResolvedValue([
      { id: 'q-prev', type: 'message', generationJobs: [{ id: 'job-prev', kind: 'image' }] },
    ]);
    mocks.resolveImageJobFiles.mockResolvedValue([{ jobId: 'job-prev', fileId: PRIOR_FILE_ID }]);

    const { body } = await call(generateBody({ prompt: 'now at night' }));

    expect(mocks.resolveImageJobFiles).toHaveBeenCalledWith({ jobIds: ['job-prev'], userId: 'user-1' });
    expect(createInput().request).toMatchObject({
      prompt: 'the lighthouse, at night',
      inputs: [{ role: 'reference', fileId: PRIOR_FILE_ID }],
    });
    expect(body.intent).toBe('continuation');
  });

  describe('a continuation whose newest image turn has no image this caller can use', () => {
    beforeEach(() => {
      mocks.resolveImagePrompt.mockResolvedValue({ rewrittenPrompt: 'again', intent: 'continuation' });
      mocks.quests.getMostRecentChatHistory.mockResolvedValue([
        { id: 'q-new', type: 'message', generationJobs: [{ id: 'job-new', kind: 'image' }] },
        { id: 'q-legacy', type: 'message', images: [LEGACY_KEY] },
      ]);
    });

    // Covers a running or failed job and a collaborator's job alike: none resolves to a file of this caller's.
    it('carries nothing rather than reaching past it to an older image', async () => {
      mocks.resolveImageJobFiles.mockResolvedValue([]);

      const { status } = await call(generateBody());

      expect(status).toBe(202);
      expect(mocks.resolveImageJobFiles).toHaveBeenCalledWith({ jobIds: ['job-new'], userId: 'user-1' });
      expect(mocks.copyGeneratedImageToFiles).not.toHaveBeenCalled();
      expect(createInput().request.inputs).toBeUndefined();
    });
  });

  describe('a continuation whose newest image is a legacy generated-bucket image', () => {
    beforeEach(() => {
      mocks.resolveImagePrompt.mockResolvedValue({ rewrittenPrompt: 'again', intent: 'continuation' });
      mocks.quests.getMostRecentChatHistory.mockResolvedValue([
        { id: 'q-legacy', type: 'message', images: [LEGACY_KEY] },
        { id: 'q-older', type: 'message', generationJobs: [{ id: 'job-old', kind: 'image' }] },
      ]);
      mocks.resolveImageJobFiles.mockResolvedValue([{ jobId: 'job-old', fileId: PRIOR_FILE_ID }]);
    });

    it('saves the image to the caller files, scans it, and carries the copy forward', async () => {
      await call(generateBody());

      expect(mocks.copyGeneratedImageToFiles).toHaveBeenCalledWith(expect.objectContaining({ user: USER }), {
        imageS3Key: LEGACY_KEY,
      });
      expect(mocks.moderateFabFileNow).toHaveBeenCalledWith(
        expect.objectContaining({ fabFileId: COPIED_FILE_ID, userId: 'user-1' })
      );
      expect(mocks.resolveImageJobFiles).not.toHaveBeenCalled();
      expect(createInput().request.inputs).toEqual([{ role: 'reference', fileId: COPIED_FILE_ID }]);
    });

    it('edits the carried copy when the selected model only edits', async () => {
      await call(generateBody({ selection: { model: 'flux-kontext-pro' } }));
      expect(createInput().request).toMatchObject({
        mode: 'edit',
        inputs: [{ role: 'edit_source', fileId: COPIED_FILE_ID }],
      });
    });

    it.each(['pending', 'blocked'] as const)(
      'carries nothing, and does not reach past it, when the copy scans %s',
      async moderationStatus => {
        mocks.moderateFabFileNow.mockResolvedValue({ ok: true, moderationStatus });

        const { status } = await call(generateBody());

        expect(status).toBe(202);
        expect(mocks.resolveImageJobFiles).not.toHaveBeenCalled();
        expect(createInput().request.inputs).toBeUndefined();
      }
    );

    it('carries nothing when the caller may not read the image', async () => {
      mocks.copyGeneratedImageToFiles.mockRejectedValue(new ForbiddenError('You do not have access to this image'));

      const { status } = await call(generateBody());

      expect(status).toBe(202);
      expect(mocks.moderateFabFileNow).not.toHaveBeenCalled();
      expect(createInput().request.inputs).toBeUndefined();
    });

    it.each([
      ['an upload budget refusal', new Error('upload budget spent')],
      ['a storage quota refusal', new Error('storage quota exceeded')],
      ['a storage failure', new Error('S3 PutObject failed')],
    ])('carries nothing, and still sends, on %s', async (_label, error) => {
      mocks.copyGeneratedImageToFiles.mockRejectedValue(error);

      const { status } = await call(generateBody());

      expect(status).toBe(202);
      expect(mocks.resolveImageJobFiles).not.toHaveBeenCalled();
      expect(createInput().request.inputs).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        '[image-jobs] legacy image could not be carried forward',
        expect.objectContaining({ error })
      );
    });

    it('carries nothing, without copying, when the caller may not create files', async () => {
      mocks.canCreateFile.mockReturnValue(false);

      const { status } = await call(generateBody());

      expect(status).toBe(202);
      expect(mocks.copyGeneratedImageToFiles).not.toHaveBeenCalled();
      expect(createInput().request.inputs).toBeUndefined();
    });

    it('does not copy the image for a fresh prompt', async () => {
      mocks.resolveImagePrompt.mockResolvedValue({ rewrittenPrompt: 'a lighthouse', intent: 'fresh' });
      await call(generateBody());
      expect(mocks.copyGeneratedImageToFiles).not.toHaveBeenCalled();
    });
  });

  it('sends attached images as references and drops attachments that are not images', async () => {
    mocks.fabFiles.findAccessibleInIds.mockResolvedValue([
      { id: ATTACHED_ID, mimeType: 'image/png' },
      { id: SOURCE_ID, mimeType: 'application/pdf' },
    ]);
    await call(generateBody({ fileIds: [SOURCE_ID, ATTACHED_ID] }));
    expect(createInput().request.inputs).toEqual([{ role: 'reference', fileId: ATTACHED_ID }]);
  });

  it('edits the attached image when the selected model only edits', async () => {
    mocks.fabFiles.findAccessibleInIds.mockResolvedValue([{ id: ATTACHED_ID, mimeType: 'image/png' }]);
    await call(generateBody({ selection: { model: 'flux-kontext-pro' }, fileIds: [ATTACHED_ID] }));
    expect(createInput().request).toMatchObject({
      model: 'flux-kontext-pro',
      mode: 'edit',
      inputs: [{ role: 'edit_source', fileId: ATTACHED_ID }],
    });
  });

  it('answers 422 and leaves no quest when an edit-only model has no image to edit', async () => {
    const { status, body } = await call(generateBody({ selection: { model: 'flux-kontext-pro' } }));
    expect(status).toBe(422);
    expect(body.error).toBe('missing_input_image');
    expect(mocks.quests.create).not.toHaveBeenCalled();
    expect(mocks.createImageJobs).not.toHaveBeenCalled();
  });

  it('passes the saved BFL safety tolerance (held to the cap) and prompt upsampling to a BFL model', async () => {
    await call(generateBody({ selection: { model: 'flux-pro-1.1', safety_tolerance: 6, prompt_upsampling: true } }));
    expect(createInput().request).toMatchObject({ safetyTolerance: 2, promptUpsampling: true });
  });

  it('leaves the BFL-only settings off a non-BFL request', async () => {
    await call(generateBody({ selection: { model: 'gpt-image-1.5', safety_tolerance: 1, prompt_upsampling: true } }));
    expect(createInput().request).not.toHaveProperty('safetyTolerance');
    expect(createInput().request).not.toHaveProperty('promptUpsampling');
  });

  it('creates a masked edit with FLUX Fill by default and takes the prompt literally', async () => {
    const { body } = await call({
      mode: 'edit',
      prompt: 'make the door red',
      sessionId: SESSION_ID,
      selection: { model: 'gpt-image-1.5' },
      editSourceFileId: SOURCE_ID,
      maskFileId: MASK_ID,
    });
    expect(mocks.resolveImagePrompt).not.toHaveBeenCalled();
    expect(createInput().request).toMatchObject({
      model: 'flux-pro-1.0-fill',
      mode: 'edit',
      prompt: 'make the door red',
      inputs: [
        { role: 'edit_source', fileId: SOURCE_ID },
        { role: 'mask', fileId: MASK_ID },
      ],
    });
    expect(body).not.toHaveProperty('intent');
    // The legacy edit sent its turn to the requester tabs but never named or summarised the notebook.
    expect(mocks.broadcastChatImageQuest).toHaveBeenCalledTimes(1);
    expect(mocks.maybeSummarizeAfterChatImage).not.toHaveBeenCalled();
    expect(mocks.nameNotebookAfterChatImage).not.toHaveBeenCalled();
  });

  it('maps a refusal to its status with the why-not reasons and removes the new quest', async () => {
    const failures = [{ field: 'size', reason: 'This model cannot make that size.' }];
    mocks.createImageJobs.mockResolvedValue({
      ok: false,
      status: 422,
      code: 'unsupported_by_model',
      message: failures[0].reason,
      failures,
    });
    const { status, body } = await call(generateBody());
    expect(status).toBe(422);
    expect(body).toEqual({ error: 'unsupported_by_model', message: failures[0].reason, failures });
    expect(mocks.quests.delete).toHaveBeenCalledWith('quest-1');
    expect(mocks.quests.update).not.toHaveBeenCalled();
  });

  it('removes the new quest and rethrows when job creation throws (model admission)', async () => {
    mocks.createImageJobs.mockRejectedValue(new Error('model requires a paid plan'));
    await expect(call(generateBody())).rejects.toThrow('model requires a paid plan');
    expect(mocks.quests.delete).toHaveBeenCalledWith('quest-1');
  });

  it('re-runs a retried quest in place, replacing its jobs, and keeps it on a refusal', async () => {
    mocks.quests.findById.mockResolvedValue({ id: 'quest-old', sessionId: SESSION_ID, generationJobs: [] });
    await call(generateBody({ questId: 'quest-old' }));
    expect(mocks.quests.create).not.toHaveBeenCalled();
    expect(createInput().questId).toBe('quest-old');
    expect(mocks.quests.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'quest-old', generationJobs: [{ id: 'j1', kind: 'image' }] }),
      expect.anything()
    );

    mocks.createImageJobs.mockResolvedValue({ ok: false, status: 402, code: 'insufficient_credits', message: 'no' });
    await call(generateBody({ questId: 'quest-old' }));
    expect(mocks.quests.delete).not.toHaveBeenCalled();
  });

  describe('owner-only turn fields in the response', () => {
    const ownerTurn = {
      id: 'quest-old',
      sessionId: SESSION_ID,
      generationJobs: [],
      pendingAction: { tool: 'send_email', params: { to: 'x' }, ts: 1 },
      slackNotification: { channel: 'C1' },
      embedding: [0.1, 0.2],
      promptMeta: { functionCalls: [{ name: 'search', id: 'c1', parameters: {}, returnValue: 'owner tool output' }] },
    };
    const sharedSession = { id: SESSION_ID, userId: 'owner-1', summary: 'a notebook about lighthouses' };

    beforeEach(() => {
      mocks.quests.findById.mockResolvedValue(ownerTurn);
      mocks.quests.update.mockResolvedValue({ ...ownerTurn, status: 'done' });
    });

    it('withholds server-only and owner-only turn fields from a non-owner', async () => {
      mocks.getOrCreateSession.mockResolvedValue({ sessionId: SESSION_ID, asyncPromises: [], session: sharedSession });

      const { body } = await call(generateBody({ questId: 'quest-old' }));
      const quest = body.quest as Record<string, unknown>;

      expect(quest.id).toBe('quest-old');
      expect(quest).not.toHaveProperty('pendingAction');
      expect(quest).not.toHaveProperty('slackNotification');
      expect(quest).not.toHaveProperty('embedding');
      expect(JSON.stringify(quest)).not.toContain('owner tool output');
    });

    it('withholds them from a non-owner when the turn update fails and the turn is built from the stored one', async () => {
      mocks.getOrCreateSession.mockResolvedValue({ sessionId: SESSION_ID, asyncPromises: [], session: sharedSession });
      mocks.quests.update.mockRejectedValue(new Error('write failed'));

      const { body } = await call(generateBody({ questId: 'quest-old' }));
      const quest = body.quest as Record<string, unknown>;

      expect(quest.id).toBe('quest-old');
      expect(quest).not.toHaveProperty('pendingAction');
      expect(quest).not.toHaveProperty('embedding');
      expect(JSON.stringify(quest)).not.toContain('owner tool output');
    });

    it('keeps the owner-only turn fields for the owner, still dropping the server-only ones', async () => {
      const { body } = await call(generateBody({ questId: 'quest-old' }));
      const quest = body.quest as Record<string, unknown>;

      expect(quest.pendingAction).toEqual(ownerTurn.pendingAction);
      expect(JSON.stringify(quest)).toContain('owner tool output');
      expect(quest).not.toHaveProperty('slackNotification');
      expect(quest).not.toHaveProperty('embedding');
    });
  });

  it('refuses a retry of a quest from another session', async () => {
    mocks.quests.findById.mockResolvedValue({ id: 'quest-old', sessionId: 'other-session' });
    await expect(call(generateBody({ questId: 'quest-old' }))).rejects.toThrow('Quest not found');
    expect(mocks.createImageJobs).not.toHaveBeenCalled();
  });

  it('skips the retried turn when carrying an image forward, so it does not take its own previous output', async () => {
    mocks.resolveImagePrompt.mockResolvedValue({ rewrittenPrompt: 'again', intent: 'continuation' });
    mocks.quests.findById.mockResolvedValue({
      id: 'quest-old',
      sessionId: SESSION_ID,
      generationJobs: [{ id: 'job-own', kind: 'image' }],
    });
    mocks.generationJobs.findById.mockResolvedValue({ id: 'job-own', state: 'succeeded' });
    mocks.quests.getMostRecentChatHistory.mockResolvedValue([
      { id: 'quest-old', type: 'message', generationJobs: [{ id: 'job-own', kind: 'image' }] },
      { id: 'q-prev', type: 'message', generationJobs: [{ id: 'job-prev', kind: 'image' }] },
    ]);
    mocks.resolveImageJobFiles.mockResolvedValue([{ jobId: 'job-prev', fileId: PRIOR_FILE_ID }]);

    await call(generateBody({ questId: 'quest-old' }));

    expect(mocks.resolveImageJobFiles).toHaveBeenCalledTimes(1);
    expect(mocks.resolveImageJobFiles).toHaveBeenCalledWith({ jobIds: ['job-prev'], userId: 'user-1' });
    expect(createInput().request.inputs).toEqual([{ role: 'reference', fileId: PRIOR_FILE_ID }]);
  });

  it.each(['pending', 'running'])('answers 409 to a retry while one of its jobs is %s', async state => {
    mocks.quests.findById.mockResolvedValue({
      id: 'quest-old',
      sessionId: SESSION_ID,
      generationJobs: [
        { id: 'job-done', kind: 'image' },
        { id: 'job-live', kind: 'image' },
      ],
    });
    mocks.generationJobs.findById.mockImplementation(async (id: string) =>
      id === 'job-live' ? { id, state } : { id, state: 'failed' }
    );

    const { status, body } = await call(generateBody({ questId: 'quest-old' }));

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'jobs_still_running' });
    expect(mocks.createImageJobs).not.toHaveBeenCalled();
    expect(mocks.quests.update).not.toHaveBeenCalled();
  });

  it('retries a failed turn update once and answers with the updated turn', async () => {
    mocks.quests.update.mockRejectedValueOnce(new Error('write conflict'));

    const { status, body } = await call(generateBody());

    expect(status).toBe(202);
    expect(mocks.quests.update).toHaveBeenCalledTimes(2);
    expect(body.quest).toMatchObject({ id: 'quest-1', generationJobs: [{ id: 'j1', kind: 'image' }] });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('still answers with the started jobs when the turn update fails twice, and logs the job ids', async () => {
    mocks.quests.update.mockRejectedValue(new Error('primary stepped down'));

    const { status, body } = await call(generateBody());

    expect(status).toBe(202);
    expect(body.quest).toMatchObject({
      id: 'quest-1',
      status: 'done',
      generationJobs: [{ id: 'j1', kind: 'image' }],
    });
    expect(body.jobs).toEqual([{ id: 'j1', groupId: 'group-1', state: 'pending' }]);
    expect(mocks.quests.delete).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      '[image-jobs] could not link the started jobs to their turn',
      expect.objectContaining({ questId: 'quest-1', jobIds: ['j1'] })
    );
  });

  it('answers 202 when a session promise or a follow-up fails after the jobs started', async () => {
    mocks.getOrCreateSession.mockResolvedValue({
      sessionId: SESSION_ID,
      // A thenable, so the rejection exists only once the route settles it (no unhandled-rejection noise).
      asyncPromises: [
        { then: (_resolve: unknown, reject: (error: Error) => void) => reject(new Error('session event')) },
      ],
      session: { id: SESSION_ID },
    });
    mocks.broadcastChatImageQuest.mockRejectedValue(new Error('broadcast failed'));
    mocks.nameNotebookAfterChatImage.mockRejectedValue(new Error('naming failed'));

    const { status, body } = await call(generateBody());

    expect(status).toBe(202);
    expect(body.jobs).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[image-jobs] a follow-up after the send failed',
      expect.objectContaining({ questId: 'quest-1' })
    );
  });

  describe('the temporary inputs of a masked edit', () => {
    const editBody = (extra: Record<string, unknown> = {}) => ({
      mode: 'edit',
      prompt: 'make the door red',
      sessionId: SESSION_ID,
      selection: { model: 'gpt-image-1.5' },
      editSourceFileId: SOURCE_ID,
      maskFileId: MASK_ID,
      ...extra,
    });

    it('hands the job the inputs this send made to delete once the jobs end', async () => {
      await call(editBody({ temporaryFileIds: [MASK_ID, SOURCE_ID] }));
      expect(createInput().discardInputFileIds).toEqual([MASK_ID, SOURCE_ID]);
      expect(mocks.discardJobInputFiles).not.toHaveBeenCalled();
    });

    it('ignores a listed id that is not one of the edit inputs', async () => {
      await call(editBody({ temporaryFileIds: [MASK_ID, ATTACHED_ID] }));
      expect(createInput().discardInputFileIds).toEqual([MASK_ID]);
    });

    it('keeps a reused source: only the listed mask is temporary', async () => {
      await call(editBody({ temporaryFileIds: [MASK_ID] }));
      expect(createInput().discardInputFileIds).toEqual([MASK_ID]);
    });

    it('marks nothing on a generation', async () => {
      await call(generateBody());
      expect(createInput()).not.toHaveProperty('discardInputFileIds');
    });

    it('deletes them at once when the job engine refuses the edit', async () => {
      mocks.createImageJobs.mockResolvedValue({ ok: false, status: 402, code: 'insufficient_credits', message: 'no' });
      await call(editBody({ temporaryFileIds: [MASK_ID] }));
      expect(mocks.discardJobInputFiles).toHaveBeenCalledWith('user-1', [MASK_ID], logger);
    });

    it('deletes them at once when job creation throws', async () => {
      mocks.createImageJobs.mockRejectedValue(new Error('model requires a paid plan'));
      await expect(call(editBody({ temporaryFileIds: [MASK_ID] }))).rejects.toThrow('model requires a paid plan');
      expect(mocks.discardJobInputFiles).toHaveBeenCalledWith('user-1', [MASK_ID], logger);
    });
  });

  describe('discarding the temporary inputs of an edit that never reaches the job engine', () => {
    const editBody = (extra: Record<string, unknown> = {}) => ({
      mode: 'edit',
      prompt: 'make the door red',
      sessionId: SESSION_ID,
      selection: { model: 'gpt-image-1.5' },
      editSourceFileId: SOURCE_ID,
      maskFileId: MASK_ID,
      temporaryFileIds: [MASK_ID, SOURCE_ID],
      ...extra,
    });
    const discarded = [MASK_ID, SOURCE_ID];

    it('deletes them when the payer is refused', async () => {
      mocks.resolveMediaBillingOrgId.mockRejectedValue(new ForbiddenError('not your org'));
      await expect(call(editBody())).rejects.toThrow('not your org');
      expect(mocks.discardJobInputFiles).toHaveBeenCalledWith('user-1', discarded, logger);
      expect(mocks.createImageJobs).not.toHaveBeenCalled();
    });

    it('deletes them when the session is not found', async () => {
      mocks.getOrCreateSession.mockRejectedValue(new NotFoundError('Session not found'));
      await expect(call(editBody())).rejects.toThrow('Session not found');
      expect(mocks.discardJobInputFiles).toHaveBeenCalledWith('user-1', discarded, logger);
    });

    it('deletes them when the retried quest is not found', async () => {
      mocks.quests.findById.mockResolvedValue(null);
      await expect(call(editBody({ questId: 'quest-9' }))).rejects.toThrow('Quest not found');
      expect(mocks.discardJobInputFiles).toHaveBeenCalledWith('user-1', discarded, logger);
    });

    it('deletes them when the body fails validation but still names the inputs', async () => {
      const { status } = await call(editBody({ prompt: '' }));
      expect(status).toBe(400);
      expect(mocks.discardJobInputFiles).toHaveBeenCalledWith('user-1', discarded, logger);
    });

    it('lists only ids that are one of the edit inputs when the body fails validation', async () => {
      const { status } = await call(editBody({ prompt: '', temporaryFileIds: [MASK_ID, ATTACHED_ID] }));
      expect(status).toBe(400);
      expect(mocks.discardJobInputFiles).toHaveBeenCalledWith('user-1', [MASK_ID], logger);
    });

    it('does not discard once the job engine has taken the inputs', async () => {
      await call(editBody());
      expect(mocks.discardJobInputFiles).not.toHaveBeenCalled();
    });
  });

  it('answers 400 for a malformed body before any session or billing work', async () => {
    const { status } = await call({ mode: 'edit', prompt: 'x', selection: { model: 'gpt-image-1.5' } });
    expect(status).toBe(400);
    expect(mocks.getOrCreateSession).not.toHaveBeenCalled();
    expect(mocks.resolveMediaBillingOrgId).not.toHaveBeenCalled();
  });

  it('rejects a billing-org-shaped stray key', async () => {
    await expect(call(generateBody({ billingOrgId: 'org-2' }))).rejects.toThrow(/billingOrgId/);
    expect(mocks.createImageJobs).not.toHaveBeenCalled();
  });
});
