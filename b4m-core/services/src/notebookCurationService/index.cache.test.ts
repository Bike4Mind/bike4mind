import { describe, it, expect, vi } from 'vitest';
import { CurationType, type CurationOptions } from '@bike4mind/common';
import { NotebookCurationService, computeCurationContentHash } from './index';

const options: CurationOptions = {
  curationType: CurationType.EXECUTIVE_SUMMARY,
  includeCode: true,
  includeDiagrams: true,
  includeDataViz: true,
  includeQuestMaster: true,
  includeResearch: true,
  includeImages: true,
  exportFormat: 'markdown',
};

const messages = [{ id: 'm1', prompt: 'hi', reply: 'hello' }];
const matchingHash = computeCurationContentHash(messages, options);

function makeAdapters(overrides: Record<string, any> = {}) {
  return {
    sessionRepository: {
      findById: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    },
    chatHistoryRepository: {
      // One batch of 1 message; loadConversationHistory stops after it (< page size).
      find: vi.fn().mockResolvedValue(messages),
    },
    fabFileRepository: {
      findById: vi.fn(),
    },
    fileStorageService: {},
    creditTransactionRepository: {},
    userRepository: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    // no llmService: reaching the exec-summary generator would throw, which lets
    // us prove whether the cache short-circuited (success) or fell through (error).
    ...overrides,
  } as any;
}

describe('curateNotebook - content-hash cache', () => {
  it('cache hit reuses the stored file, charges 0, and skips regeneration', async () => {
    const adapters = makeAdapters({
      sessionRepository: {
        findById: vi.fn().mockResolvedValue({
          id: 's1',
          curatedNotebookFileId: 'file1',
          curationContentHash: matchingHash,
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      fabFileRepository: {
        findById: vi.fn().mockResolvedValue({ id: 'file1', fileName: 'curated.md', fileSize: 42 }),
      },
    });

    const service = new NotebookCurationService(adapters);
    const result = await service.curateNotebook('s1', 'u1', options);

    expect(result.success).toBe(true);
    expect(result.curatedFileId).toBe('file1');
    expect(result.tokensDeducted).toBe(0);
    expect(result.fileName).toBe('curated.md');
    expect(result.fileSize).toBe(42);
    // No regeneration -> the hash is not re-written and the file existence was checked.
    expect(adapters.sessionRepository.update).not.toHaveBeenCalled();
    expect(adapters.fabFileRepository.findById).toHaveBeenCalledWith('file1');
  });

  it('regenerates when the hash matches but the stored file was deleted', async () => {
    const adapters = makeAdapters({
      sessionRepository: {
        findById: vi.fn().mockResolvedValue({
          id: 's1',
          curatedNotebookFileId: 'file1',
          curationContentHash: matchingHash,
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      fabFileRepository: {
        findById: vi.fn().mockResolvedValue(null), // file was deleted
      },
    });

    const service = new NotebookCurationService(adapters);
    const result = await service.curateNotebook('s1', 'u1', options);

    // It fell through to regeneration (no llmService -> exec-summary generator throws),
    // proving it did NOT short-circuit to a dangling cached id.
    expect(result.success).toBe(false);
    expect(result.error).toContain('LLM service is required');
  });

  it('does not short-circuit on the first curation (no stored hash)', async () => {
    const adapters = makeAdapters({
      sessionRepository: {
        findById: vi.fn().mockResolvedValue({ id: 's1' }), // never curated
        update: vi.fn().mockResolvedValue(undefined),
      },
    });

    const service = new NotebookCurationService(adapters);
    const result = await service.curateNotebook('s1', 'u1', options);

    expect(result.success).toBe(false);
    expect(result.error).toContain('LLM service is required');
    expect(adapters.fabFileRepository.findById).not.toHaveBeenCalled();
  });
});
