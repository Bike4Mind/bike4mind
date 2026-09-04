import { describe, it, expect, vi } from 'vitest';
import { DefaultLLMParams } from '@bike4mind/common';
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
    artifactExists: vi.fn().mockResolvedValue(false),
    // Returns the id the creation path minted, which is what the notebook's array records. The
    // shape matters: the client reads a shorter id as an incomplete legacy artifact.
    createArtifact: vi.fn().mockResolvedValue('artifact_code_red-circle-a1b2c3_1700000000000_0'),
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

const withAttachments = {
  exportVersion: '1.0.0',
  notebooks: [
    {
      ...NOTEBOOK,
      tools: [{ id: 'exported-tool-id', name: 'Tool One', createdAt: '2026-01-01T00:00:00.000Z' }],
      agents: [{ id: 'exported-agent-id', name: 'Agent One', createdAt: '2026-01-01T00:00:00.000Z' }],
    },
  ],
};

/** The store assigns the id; recording anything else leaves a reference that resolves to nothing. */
describe('attachment ids come from the store, not from this service', () => {
  const runWithAttachments = async (opts: Record<string, unknown>) => {
    const { adapters } = makeAdapters();
    (adapters.toolRepository.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'store-tool-id' });
    (adapters.agentRepository.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'store-agent-id' });
    await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      withAttachments as never,
      {
        ...OPTIONS,
        importTools: true,
        importAgents: true,
        ...opts,
      } as never
    );
    const sessionCreate = adapters.sessionRepository.create as ReturnType<typeof vi.fn>;
    const sessionUpdate = adapters.sessionRepository.updateById as ReturnType<typeof vi.fn>;
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(sessionUpdate).toHaveBeenCalledTimes(1);
    // Two payloads, because the notebook is created before its attachments exist and the ids are
    // written back afterwards: `created` is the metadata, `attached` is the four id arrays.
    return { created: sessionCreate.mock.calls[0][0], attached: sessionUpdate.mock.calls[0][1] };
  };

  // ToolSchema requires llmParams; without it every tool write was rejected and swallowed.
  it('sends llmParams so the tool write is not rejected', async () => {
    const { adapters } = makeAdapters();
    (adapters.toolRepository.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'store-tool-id' });

    await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      withAttachments as never,
      {
        ...OPTIONS,
        importTools: true,
      } as never
    );

    expect(adapters.toolRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ llmParams: DefaultLLMParams })
    );
  });

  it.each([true, false])('records store-assigned attachment ids, preserveIds=%s', async preserveIds => {
    const { attached } = await runWithAttachments({ preserveIds });
    expect(attached.toolIds).toEqual(['store-tool-id']);
    expect(attached.agentIds).toEqual(['store-agent-id']);
  });

  /**
   * `id` is not a SessionSchema path - it is Mongoose's getter-only `_id` virtual - so passing it
   * is silently dropped. Sending it anyway is what made "Preserve Original IDs" look functional
   * for notebooks when it never was.
   */
  it('does not send an id the session schema will drop', async () => {
    const { created } = await runWithAttachments({ preserveIds: true });
    expect('id' in created).toBe(false);
  });
});

/** A store that returns no id must skip the attachment, not record a stringified `undefined`. */
describe('an attachment store that returns no id is not recorded', () => {
  it('warns and records nothing rather than storing the string "undefined"', async () => {
    const { adapters } = makeAdapters();
    (adapters.toolRepository.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      withAttachments as never,
      {
        ...OPTIONS,
        importTools: true,
      } as never
    );

    const sessionData = (adapters.sessionRepository.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sessionData.toolIds).toEqual([]);
    expect(result.warnings?.join(' ')).toContain('tool store returned no id');
  });
});

describe('notebook import: artifacts', () => {
  const withArtifact = (artifact: Record<string, unknown>) => ({
    exportVersion: '1.0.0',
    notebooks: [{ ...NOTEBOOK, artifacts: [artifact] }],
  });

  const ARTIFACT = {
    id: 'artifact_1_abc',
    name: 'My Chart',
    type: 'recharts',
    content: 'chart body',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    metadata: { source: 'test' },
  };

  async function importArtifact(artifact: Record<string, unknown>, opts: Record<string, unknown> = {}) {
    const { adapters } = makeAdapters();
    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      withArtifact(artifact) as never,
      { ...OPTIONS, importArtifacts: true, ...opts } as never
    );
    return { adapters, result };
  }

  it('sends the body and maps name onto title, which is the field the schema has', async () => {
    // Every artifact import used to fail validation: the payload was hand-built with `name`, and
    // without a body there is no contentId/contentHash/contentSize to satisfy the schema.
    const { adapters } = await importArtifact(ARTIFACT);

    expect(adapters.createArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        title: 'My Chart',
        type: 'recharts',
        content: 'chart body',
        metadata: { source: 'test' },
      })
    );
  });

  it('records the id it supplied, since artifacts are read by their own id', async () => {
    const { adapters, result } = await importArtifact(ARTIFACT, { preserveIds: true });

    expect(adapters.createArtifact).toHaveBeenCalledWith(expect.objectContaining({ id: 'artifact_1_abc' }));
    expect(result.importedAttachments).toBe(1);
  });

  it('remints the id without preserveIds but carries the source identifier across', async () => {
    // `abc` is the identifier segment of the fixture's source id, and it has to survive the remint:
    // the imported reply still names it, and that is what the rendered card looks the row up by.
    // A slug of the title ("my-chart") would only match when the two happen to agree.
    const { adapters } = await importArtifact(ARTIFACT);

    const [payload] = (adapters.createArtifact as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.id).not.toBe(ARTIFACT.id);
    expect(payload.id.split('_')[2]).toBe('abc');
  });

  it('records the id the creation path returns, not the one it was handed', async () => {
    // The pair matters: an id that is stored but not the one recorded leaves the notebook pointing
    // at an artifact nobody can read.
    const { adapters } = await importArtifact(ARTIFACT);

    expect(adapters.sessionRepository.updateById).toHaveBeenCalledWith(
      'new-session-id',
      expect.objectContaining({ artifactIds: ['artifact_code_red-circle-a1b2c3_1700000000000_0'] })
    );
  });

  /**
   * The notebook has to exist before its artifacts are written, because an artifact records the
   * notebook it belongs to on itself and that is what the viewer lists by. Stamping it after the
   * fact is not an option: `session.artifactIds` is a denormalised copy no display path reads, so
   * an artifact written without a `sessionId` is created, counted, reported as a success, and
   * still invisible in the notebook it was imported into.
   */
  it('stamps the imported artifact with the notebook it belongs to', async () => {
    const { adapters } = await importArtifact(ARTIFACT);

    expect(adapters.createArtifact).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'new-session-id' }));
    // Ordering is the whole point, so assert it rather than trusting the payload: a stamp can only
    // be right if the notebook was created first.
    const created = (adapters.sessionRepository.create as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const stamped = (adapters.createArtifact as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(created).toBeLessThan(stamped);
  });

  it('refuses to reuse an id already taken rather than letting the write abort the transaction', async () => {
    // A duplicate key is a server-side error, so it would abort the transaction the whole import
    // runs in - and the catch below would report one warning while every later write failed.
    const { adapters } = makeAdapters();
    (adapters.artifactExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      withArtifact(ARTIFACT) as never,
      { ...OPTIONS, importArtifacts: true, preserveIds: true } as never
    );

    expect(adapters.createArtifact).not.toHaveBeenCalled();
    expect(result.importedAttachments).toBe(0);
    expect(result.warnings?.join(' ')).toContain('artifact_1_abc');
  });

  it('does not consult existing ids when it is minting them, since a fresh id cannot collide', async () => {
    const { adapters } = await importArtifact(ARTIFACT);

    expect(adapters.artifactExists).not.toHaveBeenCalled();
  });

  it('refuses an unrecognised type in a sentence, since the warning reaches the importer', async () => {
    // Refused rather than degraded to a default, unlike knowledge: the type picks the mime type and
    // the renderer. Asserted on the text because a bare ZodError message is a JSON dump.
    const { adapters, result } = await importArtifact({ ...ARTIFACT, type: 'not-a-real-type' });

    expect(adapters.createArtifact).not.toHaveBeenCalled();
    expect(result.importedAttachments).toBe(0);
    expect(result.warnings?.join(' ')).toContain('unrecognised artifact type "not-a-real-type"');
    expect(result.warnings?.join(' ')).not.toContain('invalid_value');
  });

  it('refuses an artifact with no body instead of writing a shell around it', async () => {
    // An artifact row whose contentId points at nothing is unreadable. An export taken before the
    // export side joined the body lands here.
    const { adapters, result } = await importArtifact({ ...ARTIFACT, content: undefined });

    expect(adapters.createArtifact).not.toHaveBeenCalled();
    expect(result.importedAttachments).toBe(0);
    expect(result.warnings?.join(' ')).toContain('My Chart');
  });

  it('counts and reports a creation failure rather than claiming it succeeded', async () => {
    const { adapters } = makeAdapters();
    (adapters.createArtifact as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('nope'));
    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      withArtifact(ARTIFACT) as never,
      { ...OPTIONS, importArtifacts: true } as never
    );

    expect(result.success).toBe(true);
    expect(result.importedAttachments).toBe(0);
    expect(result.warnings?.join(' ')).toContain('nope');
  });
});
