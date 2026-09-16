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

/**
 * The admin-settings cache behind `getSettingsMap` is a process-wide singleton with a TTL, so the
 * first import in this file fixes `MaxFileSize` for every later one. A single small value keeps the
 * over-sized fixture below cheap to build rather than a real 30MB buffer.
 */
const MAX_FILE_SIZE_MB = 1;

function makeAdapters(existingSessions: unknown[] = [], user: Record<string, unknown> = { id: 'user-1' }) {
  const bulkCreate = vi.fn().mockResolvedValue(undefined);
  const adapters = {
    sessionRepository: {
      find: vi.fn().mockResolvedValue(existingSessions),
      create: vi.fn(async (data: { id: string }) => ({ ...data, id: 'new-session-id' })),
      updateById: vi.fn(),
    },
    chatHistoryRepository: { bulkCreate, deleteMany: vi.fn() },
    knowledgeRepository: { create: vi.fn() },
    artifactIdTaken: vi.fn().mockResolvedValue(false),
    // Returns the id the creation path minted, which is what the notebook's array records. The
    // shape matters: the client reads a shorter id as an incomplete legacy artifact.
    createArtifact: vi.fn().mockResolvedValue({ id: 'artifact_code_red-circle-a1b2c3_1700000000000_0' }),
    toolRepository: { create: vi.fn(), find: vi.fn(), findById: vi.fn() },
    agentRepository: { create: vi.fn() },
    userRepository: { findById: vi.fn().mockResolvedValue(user) },
    adminSettings: {
      findAll: async () => [{ settingName: 'MaxFileSize', settingValue: String(MAX_FILE_SIZE_MB) }],
      findBySettingNames: async () => [],
    },
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
    // generateCompleteArtifactId's shape, identifier verbatim. The mixed case separates a faithful
    // carry-across from a slugified one; neither matches a slug of the title.
    id: 'artifact_recharts_Q3-Revenue_1700000000000_0',
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

    expect(adapters.createArtifact).toHaveBeenCalledWith(expect.objectContaining({ id: ARTIFACT.id }));
    expect(result.importedAttachments).toBe(1);
  });

  it('remints the id without preserveIds but carries the source identifier across', async () => {
    // `Q3-Revenue` is the identifier segment of the fixture's source id, and it has to survive the
    // remint unchanged: the imported reply still names it, and that is what the rendered card looks
    // the row up by. A slug of the title ("my-chart") matches only when the two happen to agree,
    // and a slugified identifier ("q3-revenue") never matches at all.
    const { adapters } = await importArtifact(ARTIFACT);

    const [payload] = (adapters.createArtifact as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.id).not.toBe(ARTIFACT.id);
    expect(payload.id.split('_')[2]).toBe('Q3-Revenue');
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
    (adapters.artifactIdTaken as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      withArtifact(ARTIFACT) as never,
      { ...OPTIONS, importArtifacts: true, preserveIds: true } as never
    );

    expect(adapters.createArtifact).not.toHaveBeenCalled();
    expect(result.importedAttachments).toBe(0);
    expect(result.warnings?.join(' ')).toContain(ARTIFACT.id);
  });

  it('does not consult existing ids when it is minting them, since a fresh id cannot collide', async () => {
    const { adapters } = await importArtifact(ARTIFACT);

    expect(adapters.artifactIdTaken).not.toHaveBeenCalled();
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

/**
 * The two admission gates the upload door (fabFileService/create.ts) has always applied and this
 * one did not. Both must skip one file and let the batch carry on: an import that refused the whole
 * notebook over one attachment would be a worse regression than the hole it closes.
 */
describe('notebook import: knowledge file admission', () => {
  /** Embedded content, so the gate sees server-measured bytes rather than the declared size. */
  const embedded = (name: string, bytes: number) => ({
    id: `exported-${name}`,
    name,
    mimeType: 'application/pdf',
    size: bytes,
    content: Buffer.alloc(bytes).toString('base64'),
  });

  function makeKnowledgeAdapters(user?: Record<string, unknown>) {
    const { adapters } = makeAdapters([], user);
    (adapters.knowledgeRepository.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'store-knowledge-id' });
    return adapters;
  }

  async function importKnowledge(files: Record<string, unknown>[], user?: Record<string, unknown>) {
    const adapters = makeKnowledgeAdapters(user);

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      { exportVersion: '1.0.0', notebooks: [{ ...NOTEBOOK, knowledge: files }] } as never,
      { ...OPTIONS, importKnowledge: true } as never
    );

    const attached = (adapters.sessionRepository.updateById as ReturnType<typeof vi.fn>).mock.calls[0][1];
    return { adapters, result, importedIds: attached.knowledgeIds as string[] };
  }

  it('skips a knowledge file over MaxFileSize and warns rather than aborting the import', async () => {
    // Exactly at the limit, which the upload door also refuses (`>=`).
    const { adapters, result, importedIds } = await importKnowledge([
      embedded('over-sized.pdf', MAX_FILE_SIZE_MB * 1024 * 1024),
      embedded('small.pdf', 10),
    ]);

    // Matches the gate's own wording: on the file name alone this test and the quota one below
    // would each still pass if the other gate had fired.
    expect(result.warnings).toEqual([expect.stringMatching(/over-sized\.pdf.*maximum file size/)]);
    expect(importedIds).toHaveLength(1);
    expect(adapters.knowledgeRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'small.pdf' })
    );
    // Only the admitted file reaches storage. A refused file that had already been uploaded would
    // leave an object no FabFile row points at - uncounted, unmoderated and never cleaned up.
    expect(adapters.fileStorageService.uploadFile).toHaveBeenCalledTimes(1);
    // The notebook itself still landed - the skip never reached the transaction.
    expect(result.importedNotebooks).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('counts bytes admitted earlier in the same import against the quota', async () => {
    // 1MB storageLimit (x 1e6) and nothing used: each file passes on its own against the snapshot,
    // and only the running total refuses the second one.
    const { adapters, result, importedIds } = await importKnowledge(
      [embedded('first.pdf', 600_000), embedded('second.pdf', 600_000)],
      { id: 'user-1', storageLimit: 1, currentStorageSize: 0 }
    );

    expect(result.warnings).toEqual([expect.stringMatching(/second\.pdf.*storage limit/)]);
    expect(importedIds).toHaveLength(1);
    expect(adapters.knowledgeRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'first.pdf' })
    );
  });

  it('skips a knowledge file over the storage quota and warns', async () => {
    // storageLimit is MB x 1e6, so 999_000 bytes already used leaves 1000 bytes of headroom.
    const { adapters, result, importedIds } = await importKnowledge(
      [embedded('quota-buster.pdf', 2000), embedded('small.pdf', 10)],
      { id: 'user-1', storageLimit: 1, currentStorageSize: 999_000 }
    );

    expect(result.warnings).toEqual([expect.stringMatching(/quota-buster\.pdf.*storage limit/)]);
    expect(importedIds).toHaveLength(1);
    expect(adapters.knowledgeRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'small.pdf' })
    );
    expect(adapters.fileStorageService.uploadFile).toHaveBeenCalledTimes(1);
    expect(result.importedNotebooks).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('does not charge the quota for a URL reference, which stores nothing', async () => {
    const { adapters, result, importedIds } = await importKnowledge(
      [
        { id: 'exported-ref', name: 'ref.pdf', mimeType: 'application/pdf', size: 900_000, contentUrl: 'https://x/y' },
        embedded('real.pdf', 600_000),
      ],
      { id: 'user-1', storageLimit: 1, currentStorageSize: 0 }
    );

    // copyFileFromUrl is an unimplemented throw, so those declared 900_000 bytes never reach
    // storage and must not eat the 1_000_000-byte budget real.pdf has to fit inside. The size is
    // unvalidated JSON off the uploaded payload, so charging it would also let a negative or
    // non-numeric value disable the quota gate for the rest of the import.
    expect(result.warnings).toEqual([expect.stringMatching(/ref\.pdf.*not implemented/)]);
    expect(importedIds).toHaveLength(1);
    expect(adapters.knowledgeRepository.create).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'real.pdf' }));
  });

  it('refuses a URL reference as unimplemented even when its declared size is over the limit', async () => {
    const { adapters, result } = await importKnowledge([
      {
        id: 'exported-huge-ref',
        name: 'huge-ref.pdf',
        mimeType: 'application/pdf',
        size: MAX_FILE_SIZE_MB * 1024 * 1024 * 10,
        contentUrl: 'https://x/y',
      },
    ]);

    // The declared size is the only one this branch has, and it is unvalidated JSON, so neither
    // gate may judge it. Blaming the file-size limit would tell the user to shrink a file that
    // would be refused at any size.
    expect(result.warnings).toEqual([expect.stringMatching(/huge-ref\.pdf.*not implemented/)]);
    expect(adapters.fileStorageService.uploadFile).not.toHaveBeenCalled();
  });

  it('gates on server-measured bytes rather than the declared size', async () => {
    const { adapters, result } = await importKnowledge([
      { ...embedded('liar.pdf', MAX_FILE_SIZE_MB * 1024 * 1024), size: 1 },
      { ...embedded('small.pdf', 4096), size: 1 },
    ]);

    expect(result.warnings).toEqual([expect.stringMatching(/liar\.pdf.*maximum file size/)]);
    // The row records the measured bytes too, so an understated size cannot slip past the storage
    // accounting that runs off it later.
    expect(adapters.knowledgeRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'small.pdf', fileSize: 4096 })
    );
  });

  it('carries the accumulator across notebooks within one import', async () => {
    const adapters = makeKnowledgeAdapters({ id: 'user-1', storageLimit: 1, currentStorageSize: 0 });

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      {
        exportVersion: '1.0.0',
        notebooks: [
          { ...NOTEBOOK, id: 'notebook-a', name: 'A', knowledge: [embedded('a.pdf', 600_000)] },
          { ...NOTEBOOK, id: 'notebook-b', name: 'B', knowledge: [embedded('b.pdf', 600_000)] },
        ],
      } as never,
      { ...OPTIONS, importKnowledge: true } as never
    );

    // importKnowledgeFiles runs once per notebook, so the accumulator has to be instance state to
    // see notebook A's bytes from notebook B. A per-call local would admit both.
    expect(result.warnings).toEqual([expect.stringMatching(/b\.pdf.*storage limit/)]);
    expect(result.importedNotebooks).toBe(2);
    expect(adapters.fileStorageService.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('resets the accumulator between imports on one service instance', async () => {
    const adapters = makeKnowledgeAdapters({ id: 'user-1', storageLimit: 1, currentStorageSize: 0 });

    const service = new NotebookImportService(adapters);
    const runImport = () =>
      service.importNotebooks(
        'user-1',
        { exportVersion: '1.0.0', notebooks: [{ ...NOTEBOOK, knowledge: [embedded('big.pdf', 600_000)] }] } as never,
        { ...OPTIONS, importKnowledge: true } as never
      );

    const first = await runImport();
    const second = await runImport();

    // Without the reset the second import starts 600_000 bytes in the red and refuses its only
    // file. Nothing else in this file reuses an instance, so this is the only cover that line has.
    expect(first.warnings).toEqual([]);
    expect(second.warnings).toEqual([]);
    expect(adapters.fileStorageService.uploadFile).toHaveBeenCalledTimes(2);
  });
});
