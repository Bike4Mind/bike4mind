import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';

const mockPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: (...a: unknown[]) => mockPost(...a) } }));
vi.mock('@client/app/utils/llm', () => ({
  createOptimisticQuest: (_qc: unknown, _id: unknown, _prompt: unknown, cb: () => Promise<unknown>) => cb(),
  updateOptimisticQuest: (_qc: unknown, _id: unknown, _sid: unknown, _q: unknown, cb: () => Promise<unknown>) => cb(),
  createOptimisticSessionId: () => 'tmp-session',
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ getCachedModels: () => [] }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/server-utils/utils/resolveActiveOrg', () => ({ resolveActiveOrg: vi.fn() }));
const files = vi.hoisted(() => ({
  copyGeneratedImageToFabFile: vi.fn(),
  createFabFileOnServerWithUpload: vi.fn(),
  deleteFileUtility: vi.fn(),
  getFabFileByIdFromServer: vi.fn(),
  moderateFabFileNow: vi.fn(),
}));
vi.mock('@client/app/utils/filesAPICalls', () => files);
vi.mock('@client/app/utils/generatedImageUrl', () => ({
  isGeneratedImage: (url: string) => url.includes('generatedimagesbucket'),
  extractS3KeyFromUrl: () => 'generated/key.png',
}));

import { ChatImageJobsBodySchema } from '@bike4mind/common';
import { assertNoStrayBillingOrgKeys } from '@bike4mind/server-utils/utils/orgAccess';
import { toast } from 'sonner';
import { terminalQuests } from '@client/app/hooks/chatCompletionState';
import { dispatchSend, sendChatImageEdit, sendChatImageGeneration } from './chatImageSend';

// The LLM settings the chat send path adds ride along on the args; only the image fields may reach the route.
const baseArgs = (extra: Record<string, unknown> = {}) =>
  ({
    params: 'a lighthouse',
    currentSession: { id: 'sess-1' },
    workBenchFiles: [{ id: 'f'.repeat(24) }],
    promptFileIds: ['b'.repeat(24)],
    queryClient: {} as QueryClient,
    model: 'gpt-image-1.5',
    tools: [],
    organizationId: 'org-1',
    temperature: 0.7,
    top_p: 1,
    n: 2,
    max_tokens: 1024,
    stream: true,
    thinking: { enabled: false },
    size: '1024x1024',
    quality: 'high',
    safety_tolerance: 1,
    imageConfig: { model: 'flux-pro-1.1', editModel: 'flux-pro-1.0-fill', size: '512x512', style: 'vivid' },
    ...extra,
  }) as never;

const postedBody = () => mockPost.mock.calls[0][1] as Record<string, unknown>;
const GENERATED_URL = 'https://generatedimagesbucket.s3.amazonaws.com/generated/key.png?sig=1';

beforeEach(() => {
  vi.clearAllMocks();
  mockPost.mockResolvedValue({ data: { session: {}, quest: {}, jobs: [], groupId: 'g' } });
  files.copyGeneratedImageToFabFile.mockResolvedValue({ id: 'a'.repeat(24), created: true });
  files.moderateFabFileNow.mockResolvedValue('clean');
});

describe('sendChatImageGeneration', () => {
  it('posts a chat image job body the route schema and the billing-key guard accept', async () => {
    await sendChatImageGeneration(baseArgs({ colorGrade: 'warm' }));
    expect(mockPost.mock.calls[0][0]).toBe('/api/image-jobs');
    expect(ChatImageJobsBodySchema.safeParse(postedBody()).success).toBe(true);
    expect(() => assertNoStrayBillingOrgKeys(postedBody())).not.toThrow();
    expect(postedBody()).toEqual({
      mode: 'generate',
      prompt: 'a lighthouse',
      sessionId: 'sess-1',
      selection: {
        model: 'flux-pro-1.1',
        editModel: 'flux-pro-1.0-fill',
        size: '1024x1024',
        quality: 'high',
        style: 'vivid',
        safety_tolerance: 1,
      },
      count: 2,
      promptEnhancement: false,
      fileIds: ['f'.repeat(24), 'b'.repeat(24)],
      organizationId: 'org-1',
    });
  });

  it('asks for prompt enhancement when the tool is on', async () => {
    await sendChatImageGeneration(baseArgs({ tools: ['prompt_enhancement'] }));
    expect(postedBody().promptEnhancement).toBe(true);
  });

  it('toasts the server message and rethrows on a refusal', async () => {
    const error = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { status: 400, data: { error: 'invalid_request', message: 'Bad size' } },
    });
    mockPost.mockRejectedValue(error);
    await expect(sendChatImageGeneration(baseArgs())).rejects.toBe(error);
    expect(toast.error).toHaveBeenCalledWith('Invalid request: Bad size');
  });
});

describe('sendChatImageEdit', () => {
  it('copies a generated image into Files, scans it, and posts a masked edit', async () => {
    await sendChatImageEdit(baseArgs({ image: GENERATED_URL }));
    expect(files.copyGeneratedImageToFabFile).toHaveBeenCalledWith('generated/key.png', expect.any(String));
    expect(files.moderateFabFileNow).toHaveBeenCalledWith('a'.repeat(24));
    expect(mockPost.mock.calls[0][0]).toBe('/api/image-jobs');
    expect(ChatImageJobsBodySchema.safeParse(postedBody()).success).toBe(true);
    expect(() => assertNoStrayBillingOrgKeys(postedBody())).not.toThrow();
    expect(postedBody()).toMatchObject({
      mode: 'edit',
      prompt: 'a lighthouse',
      editSourceFileId: 'a'.repeat(24),
      maskFileId: 'b'.repeat(24),
      temporaryFileIds: ['b'.repeat(24), 'a'.repeat(24)],
      selection: { model: 'flux-pro-1.1', editModel: 'flux-pro-1.0-fill' },
    });
  });

  it('keeps the caller earlier copy of a generated image: only the mask is temporary', async () => {
    files.copyGeneratedImageToFabFile.mockResolvedValue({ id: 'a'.repeat(24), created: false });
    await sendChatImageEdit(baseArgs({ image: GENERATED_URL }));
    expect(postedBody()).toMatchObject({ editSourceFileId: 'a'.repeat(24), temporaryFileIds: ['b'.repeat(24)] });
  });

  it('edits the caller own clean file behind the image directly, without a copy', async () => {
    const ownId = 'c'.repeat(24);
    files.getFabFileByIdFromServer.mockResolvedValue({ id: ownId, userId: 'user-1', moderationStatus: 'clean' });

    await sendChatImageEdit(
      baseArgs({ image: 'https://files.example.com/upload.png', imageFileId: ownId, userId: 'user-1' })
    );

    expect(files.getFabFileByIdFromServer).toHaveBeenCalledWith(ownId);
    expect(files.createFabFileOnServerWithUpload).not.toHaveBeenCalled();
    expect(files.moderateFabFileNow).not.toHaveBeenCalled();
    expect(postedBody()).toMatchObject({ editSourceFileId: ownId, temporaryFileIds: ['b'.repeat(24)] });
  });

  it.each([
    ['another user', { userId: 'user-2', moderationStatus: 'clean' }],
    ['not scanned clean', { userId: 'user-1', moderationStatus: 'pending' }],
  ])('copies the image when the file behind it is %s', async (_label, file) => {
    files.getFabFileByIdFromServer.mockResolvedValue({ id: 'c'.repeat(24), ...file });

    await sendChatImageEdit(baseArgs({ image: GENERATED_URL, imageFileId: 'c'.repeat(24), userId: 'user-1' }));

    expect(files.copyGeneratedImageToFabFile).toHaveBeenCalled();
    expect(postedBody()).toMatchObject({ editSourceFileId: 'a'.repeat(24) });
  });

  it('does not post when the copied source is blocked, and removes the copy', async () => {
    files.moderateFabFileNow.mockResolvedValue('blocked');
    await expect(sendChatImageEdit(baseArgs({ image: GENERATED_URL }))).rejects.toThrow();
    expect(files.deleteFileUtility).toHaveBeenCalledWith('a'.repeat(24));
    expect(mockPost).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('This image cannot be edited.');
  });

  it('does not delete the caller earlier copy when it scans blocked', async () => {
    files.copyGeneratedImageToFabFile.mockResolvedValue({ id: 'a'.repeat(24), created: false });
    files.moderateFabFileNow.mockResolvedValue('blocked');
    await expect(sendChatImageEdit(baseArgs({ image: GENERATED_URL }))).rejects.toThrow();
    expect(files.deleteFileUtility).toHaveBeenCalledTimes(1);
    expect(files.deleteFileUtility).toHaveBeenCalledWith('b'.repeat(24));
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('does not post while the copied source is still being scanned', async () => {
    files.moderateFabFileNow.mockResolvedValue('pending');
    await expect(sendChatImageEdit(baseArgs({ image: GENERATED_URL }))).rejects.toThrow();
    expect(mockPost).not.toHaveBeenCalled();
    expect(files.deleteFileUtility).toHaveBeenCalledWith('a'.repeat(24));
  });

  describe('when the edit fails before the request is sent', () => {
    it('deletes the mask and the copy this send made when the copy is still being scanned', async () => {
      files.moderateFabFileNow.mockResolvedValue('pending');
      await expect(sendChatImageEdit(baseArgs({ image: GENERATED_URL }))).rejects.toThrow();
      expect(files.deleteFileUtility.mock.calls.map(call => call[0]).sort()).toEqual(['a'.repeat(24), 'b'.repeat(24)]);
    });

    it('deletes the mask when resolving the source throws', async () => {
      files.copyGeneratedImageToFabFile.mockRejectedValue(new Error('copy refused'));
      await expect(sendChatImageEdit(baseArgs({ image: GENERATED_URL }))).rejects.toThrow('copy refused');
      expect(files.deleteFileUtility).toHaveBeenCalledTimes(1);
      expect(files.deleteFileUtility).toHaveBeenCalledWith('b'.repeat(24));
    });

    it('deletes the copy this send made when the scan itself throws', async () => {
      files.moderateFabFileNow.mockRejectedValue(new Error('scan failed'));
      await expect(sendChatImageEdit(baseArgs({ image: GENERATED_URL }))).rejects.toThrow('scan failed');
      expect(files.deleteFileUtility.mock.calls.map(call => call[0]).sort()).toEqual(['a'.repeat(24), 'b'.repeat(24)]);
    });

    it('never deletes a source the caller already had, only the mask', async () => {
      files.copyGeneratedImageToFabFile.mockResolvedValue({ id: 'a'.repeat(24), created: false });
      files.moderateFabFileNow.mockResolvedValue('pending');
      await expect(sendChatImageEdit(baseArgs({ image: GENERATED_URL }))).rejects.toThrow();
      expect(files.deleteFileUtility).toHaveBeenCalledTimes(1);
      expect(files.deleteFileUtility).toHaveBeenCalledWith('b'.repeat(24));
    });

    it('still rethrows the original error when a cleanup delete fails', async () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      files.copyGeneratedImageToFabFile.mockRejectedValue(new Error('copy refused'));
      files.deleteFileUtility.mockRejectedValue(new Error('delete failed'));
      await expect(sendChatImageEdit(baseArgs({ image: GENERATED_URL }))).rejects.toThrow('copy refused');
      consoleWarn.mockRestore();
    });
  });

  it('leaves the inputs to the server once the request was sent and failed', async () => {
    mockPost.mockRejectedValue(new Error('network down'));
    await expect(sendChatImageEdit(baseArgs({ image: GENERATED_URL }))).rejects.toThrow('network down');
    expect(files.deleteFileUtility).not.toHaveBeenCalled();
  });
});

describe('dispatchSend', () => {
  const llmHandler = vi.fn();
  const handlers = { '/llm': llmHandler };

  it('sends an image-model send as a chat image job, not through the command map', async () => {
    await dispatchSend(handlers, 'generate', baseArgs({ command: '/llm' }));
    expect(llmHandler).not.toHaveBeenCalled();
    expect(mockPost.mock.calls[0][0]).toBe('/api/image-jobs');
    expect(postedBody()).toMatchObject({ mode: 'generate', prompt: 'a lighthouse' });
  });

  it('sends an image edit as an edit job', async () => {
    await dispatchSend(handlers, 'edit', baseArgs({ command: '/llm', image: GENERATED_URL }));
    expect(llmHandler).not.toHaveBeenCalled();
    expect(postedBody()).toMatchObject({ mode: 'edit' });
  });

  it('sends a text-model send through the command handler, with no image job', async () => {
    await dispatchSend(handlers, undefined, baseArgs({ command: '/llm', userId: 'u-1' }));
    expect(llmHandler).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-1', params: 'a lighthouse' }));
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('clears the terminal mark of a re-run quest before the image send', async () => {
    terminalQuests.markTerminal('quest-1');
    await dispatchSend(handlers, 'generate', baseArgs({ command: '/llm', questId: 'quest-1' }));
    expect(terminalQuests.isStaleFrame('quest-1', 'running')).toBe(false);
  });
});
