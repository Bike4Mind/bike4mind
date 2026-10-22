import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';

// A tool that reports a file through statusUpdate (excel_generation saves nothing in onFinish) must
// have the key on the stored quest before the client sees it: the client resolves the key through
// GET /api/sessions/[id]/generated-media, which signs only keys the stored quest records.

type StatusCallbacks = {
  onStatusUpdate: (changes: Record<string, unknown>, status?: string) => Promise<void>;
};

const captured = vi.hoisted(() => ({ callbacks: undefined as StatusCallbacks | undefined }));

vi.mock('../sharedToolBuilder', () => ({
  buildSharedTools: (_input: unknown, callbacks: StatusCallbacks) => {
    captured.callbacks = callbacks;
    return [];
  },
}));

const build = (saveQuest = vi.fn().mockResolvedValue(null)) => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };
  const sendStatusUpdate = vi.fn().mockResolvedValue(undefined);
  const deps = {
    user: { id: 'u1', currentCredits: 1_000_000 },
    logger,
    db: { quests: { addGenerationJobs: vi.fn() } },
    toolCreditsMap: new Map(),
    toolCreditModels: new Set(),
    sendStatusUpdate,
    extraContextMessages: [],
  } as unknown as ToolBuilderConfig;
  const quest = { id: 'q1', sessionId: 's1' } as { id: string; sessionId: string; images?: string[] };

  new ToolBuilder(deps).buildTools({
    enabledTools: [],
    quest,
    saveQuest,
    llm: { currentModel: 'm', complete: vi.fn() } as unknown as ICompletionBackend,
    config: {},
    organization: null,
  } as never);
  if (!captured.callbacks) throw new Error('buildSharedTools was not called');
  return { onStatusUpdate: captured.callbacks.onStatusUpdate, quest, saveQuest, sendStatusUpdate, logger };
};

describe('ToolBuilder: onStatusUpdate persists generated-media keys before broadcasting', () => {
  beforeEach(() => {
    captured.callbacks = undefined;
  });

  it('saves the quest with the new key before the status update goes out', async () => {
    const { onStatusUpdate, quest, saveQuest, sendStatusUpdate } = build();

    await onStatusUpdate({ images: ['report.xlsx'] });

    expect(quest.images).toEqual(['report.xlsx']);
    expect(saveQuest).toHaveBeenCalledWith(quest);
    expect(saveQuest.mock.invocationCallOrder[0]).toBeLessThan(sendStatusUpdate.mock.invocationCallOrder[0]);
  });

  it('does not save for a status update without images', async () => {
    const { onStatusUpdate, saveQuest, sendStatusUpdate } = build();

    await onStatusUpdate({}, 'thinking');

    expect(saveQuest).not.toHaveBeenCalled();
    expect(sendStatusUpdate).toHaveBeenCalled();
  });

  it('still broadcasts when the save fails', async () => {
    const { onStatusUpdate, sendStatusUpdate, logger } = build(vi.fn().mockRejectedValue(new Error('mongo down')));

    await onStatusUpdate({ images: ['report.xlsx'] });

    expect(sendStatusUpdate).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('q1'), expect.any(Error));
  });
});
