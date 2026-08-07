import { describe, it, expect, vi } from 'vitest';
import { NotebookExportService } from './index';
import type { NotebookExportAdapters } from './index';

/**
 * These pin the emitted JSON, because the fields they cover were all silently wrong before the
 * adapter types were declared: the artifact mapper read a `name` that does not exist on the entity,
 * and every promptMeta field was read off the top level of a nested structure. Both compiled fine
 * under `any` and exported undefined.
 *
 * The adapters are a declared interface, so plain object literals suffice - no Mongo, no vi.mock.
 */
const SESSION = {
  id: 'session-1',
  name: 'Notebook One',
  firstCreated: new Date('2026-01-01T00:00:00Z'),
  lastUpdated: new Date('2026-01-02T00:00:00Z'),
  artifactIds: ['artifact-1'],
};

/** Mirrors the nested shape PromptMeta stores; the old mapper looked for these at the top level. */
const PROMPT_META = {
  model: { name: 'claude-opus-4', backend: 'anthropic', parameters: { temperature: 0.7, maxTokens: 4096 } },
  tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCost: 0.003 },
  performance: { totalResponseTime: 1234 },
  context: {
    contextWindowUsage: { actualInputTokens: 900 },
    // Stored on real quests; must not reach the export file.
    systemPrompt: 'SECRET-SYSTEM-PROMPT',
    userPrompt: 'SECRET-USER-PROMPT',
  },
};

/** Loose on purpose so call sites can pass bare stubs without casting each one. */
type AdapterOverrides = Partial<Record<keyof NotebookExportAdapters, unknown>>;

function makeAdapters(over: AdapterOverrides = {}) {
  const uploaded: string[] = [];
  const none = { find: vi.fn().mockResolvedValue([]) };
  const adapters = {
    sessionRepository: { find: vi.fn().mockResolvedValue([SESSION]) },
    // The loop reads batches until one comes back short, so the second call must be empty.
    chatHistoryRepository: {
      find: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'msg-1', timestamp: new Date('2026-01-01T00:00:00Z'), promptMeta: PROMPT_META }])
        .mockResolvedValue([]),
    },
    knowledgeRepository: { ...none, findOne: vi.fn().mockResolvedValue(null) },
    artifactRepository: none,
    toolRepository: none,
    agentRepository: none,
    fileStorageService: {
      getFileContent: vi.fn().mockResolvedValue(null),
      uploadFile: vi.fn(async (_path: string, content: Buffer) => {
        uploaded.push(content.toString('utf-8'));
      }),
      getSignedUrl: vi.fn().mockResolvedValue('https://example.test/export.json'),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...over,
  } as unknown as NotebookExportAdapters;
  return { adapters, uploaded };
}

const OPTIONS = {
  format: 'json',
  includeMetadata: true,
  includeArtifacts: true,
  maxFileSize: 1_000_000,
} as unknown as Parameters<NotebookExportService['exportNotebooks']>[1];

async function exportOnce(over: AdapterOverrides = {}) {
  const { adapters, uploaded } = makeAdapters(over);
  await new NotebookExportService(adapters).exportNotebooks('user-1', OPTIONS);
  expect(uploaded).toHaveLength(1);
  return JSON.parse(uploaded[0]);
}

describe('notebook export', () => {
  it('emits promptMeta from the nested groups it is actually stored in', async () => {
    const payload = await exportOnce();
    const { promptMeta } = payload.notebooks[0].chatHistory[0];

    // model goes through whole rather than rebuilt field-by-field, so a consumer reading
    // model.backend keeps working.
    expect(promptMeta.model).toEqual(PROMPT_META.model);
    expect(promptMeta.tokenUsage.inputTokens).toBe(100);
    expect(promptMeta.performance.totalResponseTime).toBe(1234);
    expect(promptMeta.context.contextWindowUsage.actualInputTokens).toBe(900);
  });

  it('skips a message with no id rather than emitting one that cannot be re-imported', async () => {
    // Re-import keys updateOne on this id; a missing one casts the filter to {} and upserts over
    // an arbitrary quest, so the row must not reach the file.
    const payload = await exportOnce({
      chatHistoryRepository: {
        find: vi
          .fn()
          .mockResolvedValueOnce([
            { timestamp: new Date('2026-01-01T00:00:00Z') },
            { id: 'msg-2', timestamp: new Date('2026-01-01T00:00:00Z') },
          ])
          .mockResolvedValue([]),
      },
    });

    const ids = payload.notebooks[0].chatHistory.map((m: { id: string }) => m.id);
    expect(ids).toEqual(['msg-2']);
  });

  it('does not export raw prompt text from the context group', async () => {
    const { adapters, uploaded } = makeAdapters();
    await new NotebookExportService(adapters).exportNotebooks('user-1', OPTIONS);

    expect(uploaded[0]).not.toContain('SECRET-SYSTEM-PROMPT');
    expect(uploaded[0]).not.toContain('SECRET-USER-PROMPT');
  });

  it('pages past a full batch and cursors by rows read, not rows kept', async () => {
    // 152 rows spans two pages of 100. One row has no id, so it is dropped from the output while
    // still occupying a position in the sort - cursoring by the kept count would re-read the tail.
    const all = Array.from({ length: 152 }, (_, i) => ({
      id: i === 7 ? undefined : `msg-${i}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      prompt: `message ${i}`,
    }));
    const find = vi.fn(async (_q: unknown, opts?: { skip?: number; limit?: number }) =>
      all.slice(opts?.skip ?? 0, (opts?.skip ?? 0) + (opts?.limit ?? all.length))
    );

    const payload = await exportOnce({ chatHistoryRepository: { find } });

    const ids = payload.notebooks[0].chatHistory.map((m: { id: string }) => m.id);
    expect(ids).toHaveLength(151);
    expect(new Set(ids).size).toBe(151);
    expect(ids).not.toContain(undefined);
    expect(ids[ids.length - 1]).toBe('msg-151');
    expect(find.mock.calls.map(([, opts]) => opts?.skip)).toEqual([0, 100]);
  });

  it('names an artifact from its title, which is the field the entity actually has', async () => {
    const payload = await exportOnce({
      artifactRepository: {
        find: vi.fn().mockResolvedValue([{ id: 'artifact-1', title: 'My Chart', type: 'recharts' }]),
      },
    });

    expect(payload.notebooks[0].artifacts[0].name).toBe('My Chart');
  });
});
