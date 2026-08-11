import { describe, it, expect, vi } from 'vitest';
import { NotebookImportService } from './index';
import type { NotebookImportAdapters } from './index';

/**
 * Imported messages are keyed by the presence or absence of `id`. Getting it wrong either failed
 * the import outright or rewrote the source notebook's own documents.
 */
const MESSAGE = {
  id: 'original-message-id',
  timestamp: '2026-01-01T00:00:00.000Z',
  type: 'message',
  status: 'done',
  pinned: false,
  prompt: 'hello',
  promptMeta: { model: { name: 'claude-opus-4' }, tokenUsage: { totalTokens: 10 } },
};

const NOTEBOOK = {
  id: 'notebook-1',
  name: 'Notebook One',
  firstCreated: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  chatHistory: [MESSAGE],
  knowledge: [],
  artifacts: [],
  tools: [],
  agents: [],
};

const PAYLOAD = { exportVersion: '1.0.0', notebooks: [NOTEBOOK] };

function makeAdapters(existingSessions: unknown[] = []) {
  const bulkCreate = vi.fn().mockResolvedValue(undefined);
  const adapters = {
    sessionRepository: {
      find: vi.fn().mockResolvedValue(existingSessions),
      create: vi.fn(async (data: { id: string }) => ({ ...data, id: 'new-session-id' })),
      updateById: vi.fn(),
    },
    chatHistoryRepository: { bulkCreate, deleteMany: vi.fn() },
    knowledgeRepository: { create: vi.fn() },
    artifactRepository: { create: vi.fn() },
    toolRepository: { create: vi.fn(), find: vi.fn(), findById: vi.fn() },
    agentRepository: { create: vi.fn() },
    userRepository: { findById: vi.fn().mockResolvedValue({ id: 'user-1' }) },
    fileStorageService: { uploadFile: vi.fn(), getFileContent: vi.fn(), getSignedUrl: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    generateId: () => 'generated-id',
  } as unknown as NotebookImportAdapters;
  return { adapters, bulkCreate };
}

const OPTIONS = {
  conflictResolution: 'rename',
  importKnowledge: false,
  importArtifacts: false,
  importTools: false,
  importAgents: false,
} as unknown as Parameters<NotebookImportService['importNotebooks']>[2];

/** Runs an import and returns the first message handed to the store. */
async function runImport(opts: Record<string, unknown>, { existing = [] as unknown[], payload = PAYLOAD } = {}) {
  const { adapters, bulkCreate } = makeAdapters(existing);
  await new NotebookImportService(adapters).importNotebooks(
    'user-1',
    payload as never,
    {
      ...OPTIONS,
      ...opts,
    } as never
  );
  expect(bulkCreate).toHaveBeenCalledTimes(1);
  return bulkCreate.mock.calls[0][0][0];
}

/** The conflict-resolution branches only run when a session already exists. */
const EXISTING = { id: 'existing-session-id', userId: 'existing-owner' };

describe('notebook import: chat history', () => {
  it('carries no id when ids are not preserved, so the store assigns one', async () => {
    const item = await runImport({ preserveIds: false });
    expect('id' in item).toBe(false);
  });

  it('carries the original id only when the caller asks to preserve ids', async () => {
    const item = await runImport({ preserveIds: true });
    expect(item.id).toBe('original-message-id');
  });

  it('rebuilds promptMeta.session onto the notebook being imported into', async () => {
    const item = await runImport({ preserveIds: false });
    // The store requires this and the export does not carry it; it must describe the new
    // notebook and the importing user, not whatever produced the file.
    expect(item.promptMeta.session).toEqual({ id: 'new-session-id', userId: 'user-1' });
    // metrics still survive
    expect(item.promptMeta.model.name).toBe('claude-opus-4');
  });

  it.each(['overwrite', 'merge'])(
    'attributes promptMeta.session to the existing notebook on the %s path',
    async resolution => {
      // These branches append to a notebook that already exists, so the session on each message
      // must name that one. They were previously unreachable in this suite, which let both call
      // sites be broken without a test failing.
      const item = await runImport({ conflictResolution: resolution }, { existing: [EXISTING] });
      expect(item.promptMeta.session).toEqual({ id: 'existing-session-id', userId: 'existing-owner' });
      expect(item.sessionId).toBe('existing-session-id');
    }
  );

  it('omits the id when preserving was asked for but the message has none', async () => {
    const payload = {
      exportVersion: '1.0.0',
      notebooks: [{ ...NOTEBOOK, chatHistory: [{ ...MESSAGE, id: undefined }] }],
    };
    const item = await runImport({ preserveIds: true }, { payload: payload as never });
    expect('id' in item).toBe(false);
  });

  it('leaves promptMeta absent when the message had none', async () => {
    const payload = {
      exportVersion: '1.0.0',
      notebooks: [{ ...NOTEBOOK, chatHistory: [{ ...MESSAGE, promptMeta: undefined }] }],
    };
    const item = await runImport({ preserveIds: false }, { payload: payload as never });
    expect(item.promptMeta).toBeUndefined();
  });
});
