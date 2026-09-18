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

type MockAdapters = ReturnType<typeof buildDefaultAdapters>;

function makeAdapters(overrides: Partial<MockAdapters> = {}): NotebookCurationAdapters {
  // Real repositories/Logger implement much larger interfaces (full CRUD, credit-holder
  // methods, internal logger state); these fixtures stub only the handful of methods
  // curateNotebook's storage path actually calls, so the merged fixture is widened to the
  // full adapters shape here rather than reimplementing every interface.
  return { ...buildDefaultAdapters(), ...overrides } as unknown as NotebookCurationAdapters;
}

describe('curateNotebook - admin MaxFileSize gate on the curated-notebook write', () => {
  it('refuses a curated document larger than the admin-configured MaxFileSize', async () => {
    const adapters = makeAdapters({
      chatHistoryRepository: {
        // 1.1MB reply comfortably clears a 1MB (the schema minimum) MaxFileSize while
        // staying well under the 100000MB storage quota this test's user carries.
        find: vi.fn().mockResolvedValue([{ id: 'm1', prompt: 'hi', reply: 'x'.repeat(1_100_000) }]),
      },
      adminSettingsRepository: {
        findAll: vi.fn().mockResolvedValue([{ settingName: 'MaxFileSize', settingValue: '1' }]),
        findBySettingNames: vi.fn().mockResolvedValue([]),
      },
    });

    const service = new NotebookCurationService(adapters);
    const result = await service.curateNotebook('s1', 'u1', options);

    expect(result.success).toBe(false);
    expect(result.error).toBe('File size exceeds maximum file size');
    expect(result.retryable).toBe(false);
    expect(adapters.fabFileRepository.create).not.toHaveBeenCalled();
  });
});

describe('curateNotebook - per-user storage quota gate on the curated-notebook write', () => {
  it('refuses a curated document that would put the user over their storage quota', async () => {
    const adapters = makeAdapters({
      chatHistoryRepository: {
        // 1.3MB reply clears a 1MB user storage quota while staying well under the
        // 30MB default MaxFileSize, isolating this test to the quota gate alone.
        find: vi.fn().mockResolvedValue([{ id: 'm1', prompt: 'hi', reply: 'x'.repeat(1_300_000) }]),
      },
      userRepository: {
        findById: vi.fn().mockResolvedValue({ id: 'u1', storageLimit: 1, currentStorageSize: 0 }),
        incrementCredits: vi.fn().mockResolvedValue({ id: 'u1' }),
      },
    });

    const service = new NotebookCurationService(adapters);
    const result = await service.curateNotebook('s1', 'u1', options);

    expect(result.success).toBe(false);
    expect(result.error).toBe('File size exceeds storage limit');
    expect(result.retryable).toBe(false);
    expect(adapters.fabFileRepository.create).not.toHaveBeenCalled();
  });
});

describe('curateNotebook - happy path through the real admission gates', () => {
  it('stores a normal-sized curated document when both gates pass', async () => {
    const adapters = makeAdapters();

    const service = new NotebookCurationService(adapters);
    const result = await service.curateNotebook('s1', 'u1', options);

    expect(result.success).toBe(true);
    expect(result.curatedFileId).toBe('fab-1');
    expect(adapters.fabFileRepository.create).toHaveBeenCalledTimes(1);
  });
});
