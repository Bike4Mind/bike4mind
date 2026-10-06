import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQSEvent, Context } from 'aws-lambda';
import type { Logger } from '@bike4mind/observability';

/**
 * Covers the `finally { await dispatchQuestCallback(body.questId, logger); }` wrapper shared by
 * the three generation queue handlers (imageGeneration, imageEdit, videoGeneration): the
 * callback must fire whether `process()` resolves or rejects, and a rejection must still
 * propagate out of `dispatch`. The three handlers' own test files only cover the factory's
 * lazy-Resource-access contract, never this finally-block behaviour.
 */

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  mockDispatchQuestCallback: vi.fn(),
  mockImageGenerationProcess: vi.fn(),
  mockImageEditProcess: vi.fn(),
  mockVideoGenerationProcess: vi.fn(),
}));

vi.mock('@server/generationCallback/dispatchQuestCallback', () => ({
  dispatchQuestCallback: h.mockDispatchQuestCallback,
}));

vi.mock('sst', () => ({
  Resource: new Proxy(
    {},
    {
      get: () => new Proxy({}, { get: () => 'mock' }),
    }
  ),
}));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: vi.fn(() => ({ __mock: 'filesStorage' })),
  getGeneratedImageStorage: vi.fn(() => ({ __mock: 'generatedImageStorage' })),
}));

// Service classes never actually touch the db repositories below (constructor ignores
// _opts), so spreading `actual` here is safe and avoids re-declaring every named export.
vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual };
});

vi.mock('@bike4mind/services/llm', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    ImageGenerationService: class MockImageGenerationService {
      constructor(_opts: unknown) {}
      process = h.mockImageGenerationProcess;
    },
    ImageEditService: class MockImageEditService {
      constructor(_opts: unknown) {}
      process = h.mockImageEditProcess;
    },
    VideoGenerationService: class MockVideoGenerationService {
      constructor(_opts: unknown) {}
      process = h.mockVideoGenerationProcess;
    },
  };
});

const fakeLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  updateMetadata: vi.fn(),
} as unknown as Logger;

const fakeContext = {} as unknown as Context;

const makeEvent = (body: Record<string, unknown>) =>
  ({ Records: [{ body: JSON.stringify(body) }] }) as unknown as SQSEvent;

describe.each([
  {
    name: 'imageGeneration',
    modulePath: './imageGeneration',
    mockProcess: h.mockImageGenerationProcess,
  },
  {
    name: 'imageEdit',
    modulePath: './imageEdit',
    mockProcess: h.mockImageEditProcess,
  },
  {
    name: 'videoGeneration',
    modulePath: './videoGeneration',
    mockProcess: h.mockVideoGenerationProcess,
  },
])('$name dispatch: generation callback runs in the finally block', ({ modulePath, mockProcess }) => {
  beforeEach(() => {
    h.mockDispatchQuestCallback.mockReset().mockResolvedValue(undefined);
    mockProcess.mockReset();
  });

  it('dispatches the generation callback once process() resolves', async () => {
    mockProcess.mockResolvedValue(undefined);
    const { dispatch } = await import(modulePath);
    const event = makeEvent({ questId: 'q-1' });

    await dispatch(event, fakeContext, fakeLogger);

    expect(mockProcess).toHaveBeenCalledTimes(1);
    expect(h.mockDispatchQuestCallback).toHaveBeenCalledWith('q-1', fakeLogger);
  });

  it('still dispatches the generation callback when process() rejects, and the rejection propagates', async () => {
    mockProcess.mockRejectedValue(new Error('process failed'));
    const { dispatch } = await import(modulePath);
    const event = makeEvent({ questId: 'q-2' });

    await expect(dispatch(event, fakeContext, fakeLogger)).rejects.toThrow('process failed');

    expect(h.mockDispatchQuestCallback).toHaveBeenCalledWith('q-2', fakeLogger);
  });
});
