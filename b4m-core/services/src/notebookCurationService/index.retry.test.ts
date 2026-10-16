import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CurationType, insufficientCreditsError, type CurationOptions } from '@bike4mind/common';
import { invalidateSettingsCache } from '@bike4mind/utils';
import { NotebookCurationService, type NotebookCurationAdapters } from './index';

// The curated-notebook write goes through fabFileService.createFabFile and must be refused by
// the same admission logic as the upload doors apply: the admin MaxFileSize setting and the
// acting user's storage quota - whether enforced here, or (for three of the four upload doors)
// by their own inline checks in front of the ungated fabFileManager.createFabFile. Both gates
// are process-wide caches keyed off the mocked db calls below, so each test invalidates them
// rather than risk leaking a value into a sibling test.
beforeEach(() => invalidateSettingsCache());
afterEach(() => invalidateSettingsCache());

const session = { id: 's1', name: 'Test Notebook', firstCreated: new Date(), lastUpdated: new Date() };

const options: CurationOptions = {
  curationType: CurationType.TRANSCRIPT,
  includeCode: true,
  includeDiagrams: true,
  includeDataViz: true,
  includeQuestMaster: true,
  includeResearch: true,
  includeImages: true,
  exportFormat: 'markdown',
};

function buildDefaultAdapters() {
  return {
    sessionRepository: {
      findById: vi.fn().mockResolvedValue(session),
      update: vi.fn().mockResolvedValue(undefined),
    },
    chatHistoryRepository: {
      find: vi.fn().mockResolvedValue([{ id: 'm1', prompt: 'hi', reply: 'hello' }]),
    },
    fabFileRepository: {
      findById: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'fab-1', fileName: 'curated.md', fileSize: 1 }),
    },
    fileStorageService: { upload: vi.fn(), generateSignedUrl: vi.fn() },
    creditTransactionRepository: { createTransaction: vi.fn().mockResolvedValue(undefined) },
    userRepository: {
      findById: vi.fn().mockResolvedValue({ id: 'u1', storageLimit: 100000, currentStorageSize: 0 }),
      incrementCredits: vi.fn().mockResolvedValue({ id: 'u1' }),
    },
    adminSettingsRepository: {
      findAll: vi.fn().mockResolvedValue([] as Array<{ settingName: string; settingValue: string }>),
      findBySettingNames: vi.fn().mockResolvedValue([] as Array<{ settingName: string; settingValue: string }>),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

describe('curation billing', () => {
  it('writes no credit transaction itself: the host bills the summary LLM calls', async () => {
    const adapters = buildDefaultAdapters();
    const service = new NotebookCurationService(adapters as unknown as NotebookCurationAdapters);
    expect(await service.curateNotebook('s1', 'u1', options)).toMatchObject({ success: true, tokensDeducted: 0 });
    expect(adapters.creditTransactionRepository.createTransaction).not.toHaveBeenCalled();
    expect(adapters.userRepository.incrementCredits).not.toHaveBeenCalled();
  });

  it('reports an out-of-credits summary as not retryable and persists nothing', async () => {
    const adapters = buildDefaultAdapters();
    const service = new NotebookCurationService({
      ...adapters,
      llmService: { complete: vi.fn().mockRejectedValue(insufficientCreditsError('Not enough credits')) },
      llmModelId: 'ops-model',
    } as unknown as NotebookCurationAdapters);
    expect(
      await service.curateNotebook('s1', 'u1', { ...options, curationType: CurationType.EXECUTIVE_SUMMARY })
    ).toEqual({ success: false, error: 'Not enough credits', retryable: false });
    expect(adapters.fabFileRepository.create).not.toHaveBeenCalled();
  });
});

it('reports a retryable storage failure without persisting or billing', async () => {
  const adapters = buildDefaultAdapters();
  adapters.fileStorageService.upload.mockRejectedValueOnce(new Error('storage unavailable'));
  const service = new NotebookCurationService(adapters as unknown as NotebookCurationAdapters);
  expect(await service.curateNotebook('s1', 'u1', options)).toMatchObject({
    success: false,
    error: 'Failed to store curated file',
    retryable: true,
  });
  expect(adapters.fabFileRepository.create).not.toHaveBeenCalled();
  expect(adapters.userRepository.incrementCredits).not.toHaveBeenCalled();
  expect(adapters.sessionRepository.update).not.toHaveBeenCalled();
});
