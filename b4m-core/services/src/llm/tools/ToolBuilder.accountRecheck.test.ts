import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImageModels } from '@bike4mind/common';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import {
  ACCOUNT_BANNED_MESSAGE,
  ACCOUNT_DISPUTE_PENDING_MESSAGE,
  ACCOUNT_SUSPENDED_MESSAGE,
  AI_ACCESS_REVOKED_MESSAGE,
  aiAccessDeniedMessage,
} from '../../userService/accountState';
import type { ToolContext } from './base/types';

// A suspension or ban applied mid-turn must refuse the next paid media tool call even though
// deps.user is the request-time snapshot: onToolStart re-reads the user before the credit gate.

type StartCallbacks = { onToolStart: (toolName: string, data: unknown) => Promise<void> };

const captured = vi.hoisted(() => ({ callbacks: undefined as StartCallbacks | undefined }));

vi.mock('../sharedToolBuilder', () => ({
  buildSharedTools: (_input: unknown, callbacks: StartCallbacks) => {
    captured.callbacks = callbacks;
    return [];
  },
}));

const mockOpenAIGenerate = vi.fn();
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    OpenAIImageService: vi.fn().mockImplementation(function () {
      return { generate: mockOpenAIGenerate };
    }),
  };
});
vi.mock('./helpers/modelAdmission', () => ({
  createToolModelAdmission: vi.fn(async () => ({ assert: vi.fn(async () => {}) })),
}));
vi.mock('../../apiKeyService', async importOriginal => {
  const actual = await importOriginal<typeof import('../../apiKeyService')>();
  return { ...actual, getEffectiveApiKey: vi.fn().mockResolvedValue('fake-key') };
});

const { imageGenerationTool } = await import('./implementation/imageGeneration');

const build = (findById: ReturnType<typeof vi.fn>) => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };
  const toolCreditsMap = new Map<string, number[]>();
  const deps = {
    user: { id: 'u1', currentCredits: 1_000_000 },
    logger,
    db: { users: { findById }, quests: { addGenerationJobs: vi.fn() } },
    toolCreditsMap,
    toolCreditModels: new Set(),
    sendStatusUpdate: vi.fn().mockResolvedValue(undefined),
    extraContextMessages: [],
  } as unknown as ToolBuilderConfig;
  const builder = new ToolBuilder(deps);
  const gateImage = vi.spyOn(builder, 'gateImageCredits').mockResolvedValue(undefined);
  const gateAudio = vi.spyOn(builder, 'gateAudioCredits').mockReturnValue(undefined);
  builder.buildTools({
    enabledTools: [],
    quest: { id: 'q1', sessionId: 's1' },
    saveQuest: vi.fn().mockResolvedValue(null),
    llm: { currentModel: 'm', complete: vi.fn() } as unknown as ICompletionBackend,
    config: {},
    organization: null,
  } as never);
  if (!captured.callbacks) throw new Error('buildSharedTools was not called');
  return { onToolStart: captured.callbacks.onToolStart, gateImage, gateAudio, toolCreditsMap, logger };
};

const MEDIA_TOOLS = ['image_generation', 'edit_image', 'audio_generation'] as const;
const BLOCKED_USERS = [
  ['suspended', { id: 'u1', moderation: { status: 'suspended' } }, ACCOUNT_SUSPENDED_MESSAGE],
  ['banned', { id: 'u1', isBanned: true }, ACCOUNT_BANNED_MESSAGE],
  ['dispute pending', { id: 'u1', disputePending: true }, ACCOUNT_DISPUTE_PENDING_MESSAGE],
  ['moderated', { id: 'u1', isModerated: true }, AI_ACCESS_REVOKED_MESSAGE],
] as const;

describe('ToolBuilder onToolStart account re-check', () => {
  beforeEach(() => {
    captured.callbacks = undefined;
    mockOpenAIGenerate.mockReset();
  });

  describe.each(MEDIA_TOOLS)('%s', toolName => {
    it.each(BLOCKED_USERS)('refuses a %s user with 403 before the credit gate', async (_label, fresh, message) => {
      expect(aiAccessDeniedMessage(fresh)).toBe(message);
      const { onToolStart, gateImage, gateAudio, toolCreditsMap } = build(vi.fn().mockResolvedValue(fresh));

      const err = await onToolStart(toolName, {}).catch((e: unknown) => e);

      expect(err).toMatchObject({ name: 'ForbiddenError', statusCode: 403, message });
      expect(gateImage).not.toHaveBeenCalled();
      expect(gateAudio).not.toHaveBeenCalled();
      expect(toolCreditsMap.size).toBe(0);
    });

    it('lets an unblocked user through to the credit gate', async () => {
      const findById = vi.fn().mockResolvedValue({ id: 'u1' });
      const { onToolStart, gateImage, gateAudio } = build(findById);

      await expect(onToolStart(toolName, {})).resolves.toBeUndefined();

      expect(findById).toHaveBeenCalledWith('u1');
      const gate = toolName === 'audio_generation' ? gateAudio : gateImage;
      expect(gate).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses with "User not found" when the user no longer exists', async () => {
    const { onToolStart, gateImage } = build(vi.fn().mockResolvedValue(null));
    await expect(onToolStart('image_generation', {})).rejects.toMatchObject({
      statusCode: 403,
      message: 'User not found',
    });
    expect(gateImage).not.toHaveBeenCalled();
  });

  it('fails closed with a generic message when the lookup throws', async () => {
    const { onToolStart, gateImage, logger } = build(vi.fn().mockRejectedValue(new Error('mongo: secret detail')));
    const err = await onToolStart('image_generation', {}).catch((e: unknown) => e);
    expect((err as Error).message).toBe('Could not verify account status. Please try again.');
    expect((err as Error).message).not.toContain('mongo');
    expect(gateImage).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('does not re-read the user for a non-media tool', async () => {
    const findById = vi.fn();
    const { onToolStart } = build(findById);
    await onToolStart('web_search', { query: 'x' });
    expect(findById).not.toHaveBeenCalled();
  });

  it('stops the real image_generation tool before the provider is called', async () => {
    const { onToolStart, gateImage } = build(vi.fn().mockResolvedValue(BLOCKED_USERS[0][1]));
    const context = {
      userId: 'u1',
      user: {},
      sessionId: 's1',
      logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
      db: {
        adminSettings: { findAll: vi.fn().mockResolvedValue([]), findBySettingNames: vi.fn().mockResolvedValue([]) },
      },
      storage: {},
      imageGenerateStorage: { upload: vi.fn(), getSignedUrl: vi.fn(), getPublicUrl: vi.fn() },
      statusUpdate: vi.fn().mockResolvedValue(undefined),
      llm: {},
      onStart: (name: string, data: unknown) => onToolStart(name, data),
    } as unknown as ToolContext;
    const { toolFn } = imageGenerationTool.implementation(context, {
      model: ImageModels.GPT_IMAGE_2,
      n: 1,
      quality: 'high',
      size: '1024x1024',
    });

    await expect(toolFn({ prompt: 'a red bike' })).rejects.toMatchObject({ statusCode: 403 });

    expect(mockOpenAIGenerate).not.toHaveBeenCalled();
    expect(gateImage).not.toHaveBeenCalled();
  });
});
