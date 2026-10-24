import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImportHistoryAdapters } from './types';
import { importHistory, ImportSource } from './index';

const h = vi.hoisted(() => ({
  zipJson: '[]',
  processed: [] as unknown[],
}));

vi.mock('yauzl', () => ({
  default: {
    open: (_path: string, _opts: unknown, cb: (err: Error | null, zip: unknown) => void) => {
      const handlers: Record<string, (entry: unknown) => void> = {};
      const entry = { fileName: 'conversations.json' };
      const makeStream = () => {
        const stream = {
          on(event: string, fn: (chunk?: unknown) => void) {
            if (event === 'data') fn(Buffer.from(h.zipJson));
            else if (event === 'end') fn();
            return stream;
          },
        };
        return stream;
      };
      const zip = {
        // Real yauzl emits entries on a later tick, after the caller has attached listeners.
        readEntry: () => process.nextTick(() => handlers.entry?.(entry)),
        on: (name: string, fn: (entry: unknown) => void) => {
          handlers[name] = fn;
          return zip;
        },
        openReadStream: (_entry: unknown, cb: (err: Error | null, stream: unknown) => void) => cb(null, makeStream()),
      };
      cb(null, zip);
    },
  },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: { globalInstance: { log: vi.fn() } },
}));
vi.mock('@bike4mind/utils', () => ({ S3Storage: class {} }));
vi.mock('./importOpenaiHistory', () => ({
  processOpenaiConversation: vi.fn(async (...args: unknown[]) => {
    h.processed.push(args);
  }),
}));
vi.mock('./importClaudeHistory', () => ({ processClaudeConversation: vi.fn() }));

const makeAdapters = (onProgress?: ImportHistoryAdapters['onProgress']): ImportHistoryAdapters =>
  ({
    db: {
      users: { findById: async () => ({ id: 'user-1' }) },
      withTransaction: async (fn: () => Promise<unknown>) => fn(),
      sessions: {},
      chatHistoryItems: {},
    },
    onProgress,
  }) as unknown as ImportHistoryAdapters;

const zipOf = (conversationCount: number) =>
  JSON.stringify(Array.from({ length: conversationCount }, (_, i) => ({ id: i })));

const run = (onProgress?: ImportHistoryAdapters['onProgress']) =>
  importHistory(
    { userId: 'user-1', source: ImportSource.OPENAI, zipFile: '/tmp/history.zip' },
    makeAdapters(onProgress)
  );

beforeEach(() => {
  h.processed.length = 0;
});

describe('importHistory counts', () => {
  it('returns the processed and total counts for a single conversation', async () => {
    h.zipJson = zipOf(1);

    await expect(run()).resolves.toEqual({ processedItems: 1, totalItems: 1 });
  });

  it('counts every conversation across batches', async () => {
    h.zipJson = zipOf(120);
    const onProgress = vi.fn(async () => {});

    await expect(run(onProgress)).resolves.toEqual({ processedItems: 120, totalItems: 120 });
    expect(onProgress.mock.calls.map(call => call.slice(2))).toEqual([
      [50, 120],
      [100, 120],
      [120, 120],
    ]);
  });

  it('returns zero counts and no progress for an empty archive', async () => {
    h.zipJson = zipOf(0);
    const onProgress = vi.fn(async () => {});

    await expect(run(onProgress)).resolves.toEqual({ processedItems: 0, totalItems: 0 });
    expect(onProgress).not.toHaveBeenCalled();
  });
});
