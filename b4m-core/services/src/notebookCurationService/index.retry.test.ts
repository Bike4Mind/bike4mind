import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CurationType, type CurationOptions } from '@bike4mind/common';
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
    // Only reached if a gate wrongly lets the write through; kept working (rather than
    // left empty) so that failure mode surfaces as the gate assertions below, not as an
    // unrelated mock gap further down the success path (credit deduction).
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

describe('curation retry after credit write failure', () => {
  it('does not advertise an unbilled file as a successful cached completion', async () => {
    const state: Record<string, unknown> = { ...session };
    const adapters = buildDefaultAdapters();
    adapters.sessionRepository.findById.mockImplementation(async () => state as typeof session);
    adapters.sessionRepository.update.mockImplementation(async value => {
      Object.assign(state, value);
    });
    adapters.fabFileRepository.findById.mockResolvedValue({ id: 'fab-1', fileName: 'curated.md', fileSize: 1 });
    adapters.creditTransactionRepository.createTransaction.mockRejectedValueOnce(new Error('credit write unavailable'));
    const service = new NotebookCurationService(adapters as unknown as NotebookCurationAdapters);
    expect((await service.curateNotebook('s1', 'u1', options)).success).toBe(false);
    const retried = await service.curateNotebook('s1', 'u1', options);
    expect(retried.success).toBe(true);
    expect(adapters.userRepository.incrementCredits).toHaveBeenCalledOnce();
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
