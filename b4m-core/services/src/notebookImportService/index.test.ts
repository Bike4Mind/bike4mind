import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultLLMParams } from '@bike4mind/common';
import { invalidateSettingsCache } from '@bike4mind/utils';
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

const KNOWLEDGE_FILE = {
  id: 'exported-knowledge-id',
  name: 'notes.txt',
  mimeType: 'text/plain',
  size: 5,
  content: Buffer.from('hello').toString('base64'),
};
const ARTIFACT = {
  id: 'artifact_recharts_Q3-Revenue_1700000000000_0',
  name: 'My Chart',
  type: 'recharts',
  content: 'chart body',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const TOOL = { id: 'exported-tool-id', name: 'Tool One', createdAt: '2026-01-01T00:00:00.000Z' };
const AGENT = { id: 'exported-agent-id', name: 'Agent One', createdAt: '2026-01-01T00:00:00.000Z' };

/** Small, so the over-sized fixtures stay cheap to build rather than real 30MB buffers. */
const MAX_FILE_SIZE_MB = 1;

/**
 * The admin-settings cache behind `getSettingsMap` is a process-wide singleton with a TTL, so
 * without this the first import in the worker fixes `MaxFileSize` for every later one - including
 * tests in other files that share the worker and supply a different value.
 */
beforeEach(() => {
  invalidateSettingsCache();
});

function makeAdapters(
  existingSessions: unknown[] = [],
  user: Record<string, unknown> = { id: 'user-1' },
  sessionRepositoryOverride?: NotebookImportAdapters['sessionRepository']
) {
  const bulkCreate = vi.fn().mockResolvedValue(undefined);
  const adapters = {
    sessionRepository: sessionRepositoryOverride ?? {
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
    fileStorageService: { uploadFile: vi.fn(), deleteFile: vi.fn(), getFileContent: vi.fn(), getSignedUrl: vi.fn() },
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
const EXISTING = {
  id: 'existing-session-id',
  userId: 'existing-owner',
  knowledgeIds: [] as string[],
  artifactIds: [] as string[],
  toolIds: [] as string[],
  agentIds: [] as string[],
};

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
      tools: [TOOL],
      agents: [AGENT],
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

/**
 * `tags`/`taggedAt` and `summary`/`summaryAt` are pairs, and an overwrite is where they get split.
 * The payload used to carry `undefined` for a value the file lacked, and mongoose deletes every
 * `undefined` from a `$set` - so the target's stale stamp survived a write that looked correct, and
 * `spider.ts` re-tags only when `!session.taggedAt`. The split was permanent.
 */
describe('notebook import: an overwrite writes what the file owns, and clears the rest', () => {
  /** Runs an overwrite over an existing session and returns the metadata update payload. */
  async function runOverwrite(notebookOverrides: Record<string, unknown> = {}) {
    const { adapters } = makeAdapters([EXISTING]);
    await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      {
        exportVersion: '1.0.0',
        notebooks: [{ ...NOTEBOOK, ...notebookOverrides }],
      } as never,
      { ...OPTIONS, conflictResolution: 'overwrite' } as never
    );
    const updateById = adapters.sessionRepository.updateById as ReturnType<typeof vi.fn>;
    expect(updateById).toHaveBeenCalledTimes(1);
    return updateById.mock.calls[0][1] as Record<string, unknown>;
  }

  it('writes taggedAt: null for an untagged file, so the notebook can be tagged again', async () => {
    const payload = await runOverwrite();

    expect(payload.tags).toEqual([]);
    // `toBeNull`, never `toBeUndefined`: the key has to carry a clearable value, because mongoose
    // drops an `undefined` from the `$set` and the target's stamp then survives the write.
    expect(payload.taggedAt).toBeNull();
  });

  it('carries the file stamp when it has one, so the spider need not pay to re-tag', async () => {
    const payload = await runOverwrite({
      tags: [{ name: 'carried', strength: 7 }],
      taggedAt: '2026-05-06T07:08:09.000Z',
    });

    expect(payload.tags).toEqual([{ name: 'carried', strength: 7 }]);
    expect(payload.taggedAt).toEqual(new Date('2026-05-06T07:08:09.000Z'));
  });

  it('clears summary and summaryAt as a pair, for the same reason', async () => {
    // A summary left next to content it no longer describes is the same silent inconsistency.
    const payload = await runOverwrite();

    expect(payload.summary).toBeNull();
    expect(payload.summaryAt).toBeNull();
  });

  it('sends no undefined value, which is what a silently-dropped field looks like', async () => {
    const payload = await runOverwrite();

    expect(Object.values(payload)).not.toContain(undefined);
    expect(Object.keys(payload)).toEqual(
      expect.arrayContaining(['lastUpdated', 'summary', 'summaryAt', 'tags', 'taggedAt'])
    );
  });

  it('leaves lastUsedModel out of the write when the file omits it, so the target keeps its own', async () => {
    // Deliberate asymmetry: no gate keys off this field, so clearing it loses information for
    // nothing. Omitting the key is how "leave it" is expressed to `$set`.
    const payload = await runOverwrite();

    expect('lastUsedModel' in payload).toBe(false);
  });
});

describe('notebook import: the create branch stamps a tagged file', () => {
  async function runCreate(notebookOverrides: Record<string, unknown> = {}) {
    const { adapters } = makeAdapters();
    await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      {
        exportVersion: '1.0.0',
        notebooks: [{ ...NOTEBOOK, ...notebookOverrides }],
      } as never,
      OPTIONS as never
    );
    return (adapters.sessionRepository.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
  }

  it('carries the stamp the file carries', async () => {
    const created = await runCreate({ taggedAt: '2026-05-06T07:08:09.000Z' });

    expect(created.taggedAt).toEqual(new Date('2026-05-06T07:08:09.000Z'));
  });

  it('leaves the stamp unset for a file with none, rather than claiming one', async () => {
    const created = await runCreate();

    // `undefined` and not `null` here: on an insert there is nothing to clear, and a `null` would
    // claim a stamp state a never-tagged notebook never had.
    expect(created.taggedAt).toBeUndefined();
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

  it('aborts the whole import when the admin settings read fails', async () => {
    const adapters = makeKnowledgeAdapters();
    adapters.adminSettings.findAll = vi.fn().mockRejectedValue(new Error('settings unavailable'));

    // Fail-closed, and deliberately not a per-file warning: an unresolved MaxFileSize means the
    // gate cannot be applied at all, so admitting the import would write bytes past a limit nobody
    // read. Refusing the whole job is recoverable - the user still holds the export file.
    const error = await new NotebookImportService(adapters)
      .importNotebooks(
        'user-1',
        { exportVersion: '1.0.0', notebooks: [{ ...NOTEBOOK, knowledge: [embedded('any.pdf', 10)] }] } as never,
        { ...OPTIONS, importKnowledge: true } as never
      )
      .catch((e: unknown) => e as { code?: string; details?: unknown });

    expect(error.code).toBe('IMPORT_FAILED');
    // The outer handler rewrites every unexpected error to one IMPORT_FAILED string, so only
    // `details` distinguishes this failure from any other.
    expect((error.details as Error).message).toMatch(/settings unavailable/);
    expect(adapters.fileStorageService.uploadFile).not.toHaveBeenCalled();
    expect(adapters.sessionRepository.create).not.toHaveBeenCalled();
  });

  it('gates on the setting default when no MaxFileSize row is stored', async () => {
    const adapters = makeKnowledgeAdapters();
    adapters.adminSettings.findAll = vi.fn().mockResolvedValue([]);

    // The only case that exercises the fallback: every other fixture here supplies a row, and the
    // e2e lane that stubs findAll to [] never asserts the resulting limit. A fallback that resolved
    // to NaN would admit every file, since `size >= NaN` is false.
    // Plain characters rather than an encoded buffer - the gate measures string length and refuses
    // before decoding, which is the only reason a fixture this size is affordable.
    const huge = { id: 'x', name: 'huge.pdf', mimeType: 'application/pdf', size: 1, content: 'A'.repeat(42_000_000) };

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      { exportVersion: '1.0.0', notebooks: [{ ...NOTEBOOK, knowledge: [huge] }] } as never,
      { ...OPTIONS, importKnowledge: true } as never
    );

    expect(result.warnings).toEqual([expect.stringMatching(/huge\.pdf.*exceeds the 30MB maximum file size/)]);
    expect(adapters.fileStorageService.uploadFile).not.toHaveBeenCalled();
  });

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

  it('books the stored byte length, not the pre-decode gate length, on malformed base64', async () => {
    // '!' is not a base64 character: byteLength derives 300_000 from the string length alone,
    // Buffer.from drops every character and yields 0.
    const junk = '!'.repeat(400_000);
    const { adapters, result } = await importKnowledge([
      { id: 'exported-junk', name: 'junk.pdf', mimeType: 'application/pdf', size: 300_000, content: junk },
    ]);

    expect(Buffer.byteLength(junk, 'base64')).toBe(300_000);
    expect(result.warnings).toEqual([]);
    expect(adapters.knowledgeRepository.create).toHaveBeenCalledWith(expect.objectContaining({ fileSize: 0 }));

    const [, uploaded] = (adapters.fileStorageService.uploadFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((uploaded as Buffer).byteLength).toBe(0);
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

  it('does not charge the quota for a file whose upload failed', async () => {
    const adapters = makeKnowledgeAdapters({ id: 'user-1', storageLimit: 1, currentStorageSize: 0 });
    (adapters.fileStorageService.uploadFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('storage unavailable')
    );

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      {
        exportVersion: '1.0.0',
        notebooks: [{ ...NOTEBOOK, knowledge: [embedded('a.pdf', 600_000), embedded('b.pdf', 600_000)] }],
      } as never,
      { ...OPTIONS, importKnowledge: true } as never
    );

    // 1MB of headroom and two 600_000-byte files: b fits only because a's failed upload spent
    // nothing. Charging before the upload lands refuses b instead, which is the regression this
    // covers - every other case here resolves uploadFile, so nothing else would catch it.
    expect(result.warnings).toEqual([expect.stringMatching(/a\.pdf.*storage unavailable/)]);
    expect(adapters.fileStorageService.uploadFile).toHaveBeenCalledTimes(2);
    expect(adapters.knowledgeRepository.create).toHaveBeenCalledTimes(1);
    expect(adapters.knowledgeRepository.create).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'b.pdf' }));
  });

  it('keeps charging the quota for a stored file whose row write failed', async () => {
    const adapters = makeKnowledgeAdapters({ id: 'user-1', storageLimit: 1, currentStorageSize: 0 });
    (adapters.knowledgeRepository.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('write failed'));

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      {
        exportVersion: '1.0.0',
        notebooks: [{ ...NOTEBOOK, knowledge: [embedded('a.pdf', 600_000), embedded('b.pdf', 600_000)] }],
      } as never,
      { ...OPTIONS, importKnowledge: true } as never
    );

    // The mirror of the upload-failure case above, and the reason the charge sits above the row
    // write rather than below it: a.pdf's bytes were uploaded even though its row never landed, so
    // b.pdf must not be handed headroom those bytes occupy. The compensating delete below does
    // remove the object, but the charge deliberately stays anyway - that delete is best-effort, and
    // the only guard against several files jointly overshooting the quota cannot depend on it.
    // Moving the charge below the create admits b.
    expect(result.warnings).toEqual([
      expect.stringMatching(/a\.pdf.*write failed/),
      expect.stringMatching(/b\.pdf.*storage limit/),
    ]);
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

/**
 * The bytes are written before the `FabFile` row that points at them, and the upload cannot join
 * the caller's transaction, so a rejected row write leaves an object nothing references. The
 * service removes it itself - but only when the write failed, and never at the cost of the import.
 */
describe('notebook import: a knowledge file whose row write fails leaves no object behind', () => {
  const embedded = (name: string, bytes = 16) => ({
    id: `exported-${name}`,
    name,
    mimeType: 'application/pdf',
    size: bytes,
    content: Buffer.alloc(bytes).toString('base64'),
  });

  function makeService() {
    const { adapters } = makeAdapters();
    (adapters.knowledgeRepository.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'store-knowledge-id' });
    return adapters;
  }

  function importKnowledge(adapters: NotebookImportAdapters, files: Record<string, unknown>[]) {
    return new NotebookImportService(adapters).importNotebooks(
      'user-1',
      { exportVersion: '1.0.0', notebooks: [{ ...NOTEBOOK, knowledge: files }] } as never,
      { ...OPTIONS, importKnowledge: true } as never
    );
  }

  it('deletes the object it uploaded when the row write rejects, and still commits', async () => {
    const adapters = makeService();
    (adapters.knowledgeRepository.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('write failed'));

    const result = await importKnowledge(adapters, [embedded('a.pdf')]);

    // The exact string the upload used: a delete of anything else would miss the object.
    const [uploadedPath] = (adapters.fileStorageService.uploadFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(adapters.fileStorageService.deleteFile).toHaveBeenCalledTimes(1);
    expect(adapters.fileStorageService.deleteFile).toHaveBeenCalledWith(uploadedPath);
    // The outcome is unchanged: the file is warned and the notebook still lands. The delete is
    // compensation, not a new failure mode.
    expect(result.errors).toEqual([]);
    expect(result.importedNotebooks).toBe(1);
    expect(result.warnings).toEqual([expect.stringMatching(/a\.pdf.*write failed/)]);
  });

  it('does not let a failing compensating delete escalate into a failed import', async () => {
    const adapters = makeService();
    (adapters.knowledgeRepository.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('write failed'));
    (adapters.fileStorageService.deleteFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('delete failed')
    );

    const result = await importKnowledge(adapters, [embedded('a.pdf')]);

    // The user hears about the row-write failure, never the delete failure, and the notebook still
    // lands: a failed delete degrades to the orphan this fix improves on, nothing more.
    expect(adapters.fileStorageService.deleteFile).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([]);
    expect(result.importedNotebooks).toBe(1);
    expect(result.warnings).toEqual([expect.stringMatching(/a\.pdf.*write failed/)]);
    expect(result.warnings?.join(' ')).not.toContain('delete failed');
    expect(adapters.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete uploaded knowledge file'),
      expect.objectContaining({ filePath: expect.any(String) })
    );
  });

  it('does not delete when the row write succeeded', async () => {
    const adapters = makeService();

    const result = await importKnowledge(adapters, [embedded('a.pdf')]);

    expect(result.importedAttachments).toBe(1);
    expect(adapters.fileStorageService.deleteFile).not.toHaveBeenCalled();
  });

  it('does not delete when the row was written but its id was unreadable', async () => {
    const adapters = makeService();
    (adapters.knowledgeRepository.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    const result = await importKnowledge(adapters, [embedded('a.pdf')]);

    // `takeStoreId` threw after a successful insert, so a row DOES point at this object. Deleting
    // it would leave the row pointing at nothing - the inverse orphan the rescue sweep collects.
    expect(result.warnings).toEqual([expect.stringMatching(/a\.pdf.*no id/)]);
    expect(adapters.fileStorageService.deleteFile).not.toHaveBeenCalled();
  });

  it('names a nameless entry by its export id rather than "undefined"', async () => {
    const adapters = makeService();
    (adapters.knowledgeRepository.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('write failed'));

    // `name` is not required by the export format, so an entry missing it - the exact entry that
    // fails the write - used to report as `"undefined"`, naming nothing at all.
    const result = await importKnowledge(adapters, [{ ...embedded('a.pdf'), id: 'kf-1', name: undefined }]);

    expect(result.warnings?.[0]).toContain('kf-1');
    expect(result.warnings?.[0]).not.toContain('undefined');
  });

  it('falls back to the entry position when name and id are both absent', async () => {
    const adapters = makeService();
    const create = adapters.knowledgeRepository.create as ReturnType<typeof vi.fn>;
    create.mockReset();
    create.mockResolvedValueOnce({ id: 'store-knowledge-id' }).mockRejectedValueOnce(new Error('write failed'));

    const result = await importKnowledge(adapters, [
      embedded('first.pdf'),
      { ...embedded('second.pdf'), id: undefined, name: undefined },
    ]);

    expect(result.warnings?.[0]).toContain('knowledge[1]');
  });
});

/**
 * Before the fix, `handleExistingSession` returned from the overwrite and merge branches above the
 * attachment-import block in `importNotebook`, so an existing notebook could never gain attachments
 * through either resolution - they imported cleanly only on the create path.
 */
describe('notebook import: overwrite and merge attach files to the existing session', () => {
  const payloadWithAllAttachments = {
    exportVersion: '1.0.0',
    notebooks: [{ ...NOTEBOOK, knowledge: [KNOWLEDGE_FILE], artifacts: [ARTIFACT], tools: [TOOL], agents: [AGENT] }],
  };

  const ALL_ATTACHMENTS = { importKnowledge: true, importArtifacts: true, importTools: true, importAgents: true };

  function makeAttachmentAdapters(existingSessions: unknown[] = [EXISTING]) {
    const { adapters } = makeAdapters(existingSessions);
    (adapters.knowledgeRepository.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'store-knowledge-id' });
    (adapters.createArtifact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'store-artifact-id' });
    (adapters.toolRepository.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'store-tool-id' });
    (adapters.agentRepository.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'store-agent-id' });
    return adapters;
  }

  it.each(['overwrite', 'merge'])(
    'imports all four attachment kinds and stamps the artifact with the existing session id, resolution=%s',
    async resolution => {
      const adapters = makeAttachmentAdapters();

      const result = await new NotebookImportService(adapters).importNotebooks(
        'user-1',
        payloadWithAllAttachments as never,
        { ...OPTIONS, conflictResolution: resolution, ...ALL_ATTACHMENTS } as never
      );

      expect(result.importedAttachments).toBe(4);
      expect(result.warnings).toEqual([]);
      expect(result.errors).toEqual([]);
      // Stamped with the EXISTING session id, so the artifact is reachable in the viewer -
      // true on both resolutions, since both write attachments onto the target rather than a
      // freshly created session.
      expect(adapters.createArtifact).toHaveBeenCalledWith(expect.objectContaining({ sessionId: EXISTING.id }));
    }
  );

  it.each(['overwrite', 'merge'])(
    'keeps the target pre-existing attachment ids and unions in the new ones, in one write, resolution=%s',
    async resolution => {
      const existingWithAttachments = {
        ...EXISTING,
        knowledgeIds: ['old-knowledge-id'],
        artifactIds: ['old-artifact-id'],
        toolIds: ['old-tool-id'],
        agentIds: ['old-agent-id'],
      };
      const adapters = makeAttachmentAdapters([existingWithAttachments]);

      await new NotebookImportService(adapters).importNotebooks(
        'user-1',
        payloadWithAllAttachments as never,
        { ...OPTIONS, conflictResolution: resolution, ...ALL_ATTACHMENTS } as never
      );

      const updateById = adapters.sessionRepository.updateById as ReturnType<typeof vi.fn>;
      // One write per notebook: the fold happens in memory, not as a second read-then-write round trip.
      expect(updateById).toHaveBeenCalledTimes(1);
      const [, update] = updateById.mock.calls[0];
      expect(update.knowledgeIds).toEqual(['old-knowledge-id', 'store-knowledge-id']);
      expect(update.artifactIds).toEqual(['old-artifact-id', 'store-artifact-id']);
      expect(update.toolIds).toEqual(['old-tool-id', 'store-tool-id']);
      expect(update.agentIds).toEqual(['old-agent-id', 'store-agent-id']);
    }
  );
});

/**
 * A name-aware fake session store: `find` filters by name and `create` pushes into the same
 * array, so a later `find` in this run sees a session an earlier notebook in it just wrote - which
 * is what proves the per-run claim routes a second same-named notebook to create rather than
 * reusing the first one. The flat `mockResolvedValue` the other describes use returns the same
 * array regardless of what `create` does, so it cannot exercise that; and on the `rename` path
 * specifically, a `find` that matches every name makes `generateUniqueName` loop forever and kills
 * the vitest worker, so any fixture exercising `rename` needs this too.
 */
function makeSessionStore(initial: Array<Record<string, unknown>>) {
  const sessions = initial.map(s => ({ ...s }));
  let counter = 0;
  return {
    sessionRepository: {
      find: vi.fn(async (query: { userId: string; name: string }) =>
        sessions.filter(s => s.userId === query.userId && s.name === query.name)
      ),
      create: vi.fn(async (data: Record<string, unknown>) => {
        const created = { ...data, id: `created-session-${counter++}` };
        sessions.push(created);
        return created;
      }),
      updateById: vi.fn(async (id: string, data: Record<string, unknown>) => {
        const target = sessions.find(s => s.id === id);
        if (target) Object.assign(target, data);
        return target;
      }),
    } as unknown as NotebookImportAdapters['sessionRepository'],
  };
}

/**
 * Before the fix, `findExistingSession` matched on `{userId, name}` alone and returned
 * `existingSessions[0]` with no bookkeeping across notebooks in the same run, so two same-named
 * incoming notebooks resolved to the same target and the second silently overwrote the first.
 */
describe('notebook import: per-run claims keep two same-named notebooks distinct', () => {
  it('overwrites the first "Dup", renames the second past it, and both keep their tools', async () => {
    const { sessionRepository } = makeSessionStore([
      {
        id: 'existing-dup-id',
        userId: 'user-1',
        name: 'Dup',
        knowledgeIds: [],
        artifactIds: [],
        toolIds: [],
        agentIds: [],
      },
    ]);
    const { adapters } = makeAdapters([], { id: 'user-1' }, sessionRepository);
    (adapters.toolRepository.create as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'tool-a' })
      .mockResolvedValueOnce({ id: 'tool-b' });

    const dupNotebook = (toolId: string) => ({
      ...NOTEBOOK,
      name: 'Dup',
      tools: [{ id: toolId, name: 'A Tool', createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    const payload = {
      exportVersion: '1.0.0',
      notebooks: [dupNotebook('exported-tool-a'), dupNotebook('exported-tool-b')],
    };

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      payload as never,
      { ...OPTIONS, conflictResolution: 'overwrite', importTools: true } as never
    );

    expect(result.newNotebookIds).toHaveLength(2);
    expect(result.newNotebookIds![0]).not.toBe(result.newNotebookIds![1]);
    expect(result.newNotebookIds).toContain('existing-dup-id');
    expect(result.importedAttachments).toBe(2);

    // The second "Dup" could not overwrite the first - this run already claimed it - so it must
    // land under a unique name (the same uniquifier `rename` uses) with a warning naming both.
    const secondCreate = (sessionRepository.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(secondCreate.name).toBe('Dup (1)');
    expect(result.warnings).toEqual([expect.stringMatching(/Dup.*Dup \(1\)/)]);
  });
});

/** `skip` writes nothing, so it must never claim - a later same-named notebook has to see, and
 * skip against, the same target rather than falling through to create. */
describe('notebook import: skip is unaffected by per-run claims', () => {
  it('skips both same-named incoming notebooks against one existing target', async () => {
    const { adapters } = makeAdapters([EXISTING]);
    const payload = {
      exportVersion: '1.0.0',
      notebooks: [NOTEBOOK, { ...NOTEBOOK, id: 'notebook-2' }],
    };

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      payload as never,
      { ...OPTIONS, conflictResolution: 'skip' } as never
    );

    expect(result.skippedNotebooks).toBe(2);
    expect(result.importedNotebooks).toBe(0);
    expect(adapters.sessionRepository.create).not.toHaveBeenCalled();
    expect(adapters.sessionRepository.updateById).not.toHaveBeenCalled();
  });

  it('creates the first of two same-named notebooks and skips the second when nothing pre-exists', async () => {
    // Guards the create-path half of the claim rule: if `skip` ever claimed the session it just
    // created, the second notebook's lookup would filter that row out as claimed and fall through
    // to create a duplicate-named twin instead of skipping against it, as `main` does.
    const { sessionRepository } = makeSessionStore([]);
    const { adapters } = makeAdapters([], { id: 'user-1' }, sessionRepository);
    const payload = {
      exportVersion: '1.0.0',
      notebooks: [NOTEBOOK, { ...NOTEBOOK, id: 'notebook-2' }],
    };

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      payload as never,
      { ...OPTIONS, conflictResolution: 'skip' } as never
    );

    expect(result.importedNotebooks).toBe(1);
    expect(result.skippedNotebooks).toBe(1);
    expect(sessionRepository.create).toHaveBeenCalledTimes(1);
  });
});

describe('notebook import: rename attaches to the new notebook, not the original', () => {
  it('gives the renamed notebook its own attachments and leaves the original untouched', async () => {
    const { sessionRepository } = makeSessionStore([
      {
        id: 'existing-session-id',
        userId: 'user-1',
        name: 'Notebook One',
        knowledgeIds: [],
        artifactIds: [],
        toolIds: ['old-tool-id'],
        agentIds: [],
      },
    ]);
    const { adapters } = makeAdapters([], { id: 'user-1' }, sessionRepository);
    (adapters.toolRepository.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'store-tool-id' });

    const payload = {
      exportVersion: '1.0.0',
      notebooks: [{ ...NOTEBOOK, tools: [TOOL] }],
    };

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      payload as never,
      { ...OPTIONS, conflictResolution: 'rename', importTools: true } as never
    );

    expect(result.importedNotebooks).toBe(1);
    const renamedId = result.newNotebookIds![0];
    expect(renamedId).not.toBe('existing-session-id');

    const updateById = sessionRepository.updateById as ReturnType<typeof vi.fn>;
    expect(updateById).toHaveBeenCalledWith(renamedId, expect.objectContaining({ toolIds: ['store-tool-id'] }));
    expect(updateById).not.toHaveBeenCalledWith('existing-session-id', expect.anything());
  });
});

describe('notebook import: overwrite handles an id collision as a warning, not a fatal error', () => {
  it('unions the ids that landed and keeps the pre-existing ones, when preserveIds collides', async () => {
    const existingWithAttachments = {
      ...EXISTING,
      artifactIds: ['old-artifact-id'],
      toolIds: ['old-tool-id'],
    };
    const { adapters } = makeAdapters([existingWithAttachments]);
    (adapters.artifactIdTaken as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (adapters.toolRepository.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'store-tool-id' });

    const payload = {
      exportVersion: '1.0.0',
      notebooks: [{ ...NOTEBOOK, artifacts: [ARTIFACT], tools: [TOOL] }],
    };

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      payload as never,
      {
        ...OPTIONS,
        conflictResolution: 'overwrite',
        preserveIds: true,
        importArtifacts: true,
        importTools: true,
      } as never
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings?.join(' ')).toContain('already exists');
    const updateById = adapters.sessionRepository.updateById as ReturnType<typeof vi.fn>;
    const [, update] = updateById.mock.calls[0];
    // The collision loses only the artifact that collided - the target's pre-existing artifact id
    // survives, and the tool that succeeded alongside it still lands.
    expect(update.artifactIds).toEqual(['old-artifact-id']);
    expect(update.toolIds).toEqual(['old-tool-id', 'store-tool-id']);
  });
});

describe('notebook import: overwrite carries a partial attachment failure into one union write', () => {
  it('unions only the attachments that succeeded and still surfaces the failure as a warning', async () => {
    const existingWithAttachments = { ...EXISTING, knowledgeIds: ['old-knowledge-id'] };
    const { adapters } = makeAdapters([existingWithAttachments]);
    (adapters.knowledgeRepository.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'store-knowledge-id' });
    (adapters.toolRepository.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('store unavailable'));

    const payload = {
      exportVersion: '1.0.0',
      notebooks: [{ ...NOTEBOOK, knowledge: [KNOWLEDGE_FILE], tools: [TOOL] }],
    };

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      payload as never,
      { ...OPTIONS, conflictResolution: 'overwrite', importKnowledge: true, importTools: true } as never
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings?.join(' ')).toContain('store unavailable');
    const updateById = adapters.sessionRepository.updateById as ReturnType<typeof vi.fn>;
    expect(updateById).toHaveBeenCalledTimes(1);
    const [, update] = updateById.mock.calls[0];
    expect(update.knowledgeIds).toEqual(['old-knowledge-id', 'store-knowledge-id']);
    expect(update.toolIds).toEqual([]);
  });
});

describe('notebook import: overwrite gates knowledge files the same way create does', () => {
  it('warns on an over-sized knowledge file and still lands the rest of the attachments', async () => {
    const { adapters } = makeAdapters([EXISTING]);
    (adapters.knowledgeRepository.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'store-knowledge-id' });
    (adapters.toolRepository.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'store-tool-id' });

    const oversized = {
      id: 'exported-big',
      name: 'big.pdf',
      mimeType: 'application/pdf',
      size: MAX_FILE_SIZE_MB * 1024 * 1024,
      content: Buffer.alloc(MAX_FILE_SIZE_MB * 1024 * 1024).toString('base64'),
    };

    const payload = {
      exportVersion: '1.0.0',
      notebooks: [{ ...NOTEBOOK, knowledge: [oversized], tools: [TOOL] }],
    };

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      payload as never,
      { ...OPTIONS, conflictResolution: 'overwrite', importKnowledge: true, importTools: true } as never
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([expect.stringMatching(/big\.pdf.*maximum file size/)]);
    const updateById = adapters.sessionRepository.updateById as ReturnType<typeof vi.fn>;
    const [, update] = updateById.mock.calls[0];
    expect(update.knowledgeIds).toEqual([]);
    expect(update.toolIds).toEqual(['store-tool-id']);
  });
});

describe('notebook import: a renamed notebook claims its new session', () => {
  it('falls a later notebook exported under that generated name through to its own rename, with a warning', async () => {
    const { sessionRepository } = makeSessionStore([
      {
        id: 'existing-dup-id',
        userId: 'user-1',
        name: 'Dup',
        knowledgeIds: [],
        artifactIds: [],
        toolIds: [],
        agentIds: [],
      },
    ]);
    const { adapters } = makeAdapters([], { id: 'user-1' }, sessionRepository);

    const payload = {
      exportVersion: '1.0.0',
      notebooks: [
        { ...NOTEBOOK, name: 'Dup' },
        { ...NOTEBOOK, id: 'notebook-2', name: 'Dup (1)' },
      ],
    };

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      payload as never,
      { ...OPTIONS, conflictResolution: 'rename' } as never
    );

    expect(result.importedNotebooks).toBe(2);
    // The first notebook renames past the existing "Dup" into a fresh "Dup (1)" session. That
    // session must be claimed - if it were not, the second notebook (exported under that literal
    // name) would resolve to it as an unclaimed match and rename past it silently, instead of
    // hitting the claimed-session fallback and warning about it.
    expect(result.warnings).toEqual([expect.stringMatching(/Dup \(1\).*Dup \(1\) \(1\)/)]);
  });
});

describe('notebook import: the claimed-name notice survives truncation', () => {
  it('puts the claimed-name notice first, ahead of an earlier attachment warning', async () => {
    const { sessionRepository } = makeSessionStore([]);
    const { adapters } = makeAdapters([], { id: 'user-1' }, sessionRepository);

    const oversized = {
      id: 'exported-big',
      name: 'big.pdf',
      mimeType: 'application/pdf',
      size: MAX_FILE_SIZE_MB * 1024 * 1024,
      content: Buffer.alloc(MAX_FILE_SIZE_MB * 1024 * 1024).toString('base64'),
    };
    const payload = {
      exportVersion: '1.0.0',
      notebooks: [
        { ...NOTEBOOK, name: 'Name', knowledge: [oversized] },
        { ...NOTEBOOK, id: 'notebook-2', name: 'Name' },
      ],
    };

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      payload as never,
      { ...OPTIONS, conflictResolution: 'overwrite', importKnowledge: true } as never
    );

    // The attachment warning is pushed first, while the first notebook is still being processed -
    // the claimed-name notice for the second notebook only exists once the second notebook runs.
    // It is still the one the user must act on, so it has to sit ahead of it: the caller truncates
    // to 5 (notebookImportComplete.ts), and five attachment warnings would otherwise push it out.
    expect(result.warnings).toEqual([
      expect.stringMatching(/Could not reuse the notebook named "Name"/),
      expect.stringMatching(/big\.pdf.*maximum file size/),
    ]);
  });
});

describe("notebook import: generateUniqueName reuses this run's highest suffix as a starting hint", () => {
  it('renames the second and third of three same-named notebooks in a bounded number of queries', async () => {
    const { sessionRepository } = makeSessionStore([
      {
        id: 'existing-dup-id',
        userId: 'user-1',
        name: 'Dup',
        knowledgeIds: [],
        artifactIds: [],
        toolIds: [],
        agentIds: [],
      },
    ]);
    const { adapters } = makeAdapters([], { id: 'user-1' }, sessionRepository);

    const dupNotebook = (id: string) => ({ ...NOTEBOOK, id, name: 'Dup' });
    const payload = {
      exportVersion: '1.0.0',
      notebooks: [dupNotebook('notebook-1'), dupNotebook('notebook-2'), dupNotebook('notebook-3')],
    };

    const result = await new NotebookImportService(adapters).importNotebooks(
      'user-1',
      payload as never,
      { ...OPTIONS, conflictResolution: 'overwrite' } as never
    );

    expect(result.importedNotebooks).toBe(3);
    const createdNames = (sessionRepository.create as ReturnType<typeof vi.fn>).mock.calls.map(
      call => (call[0] as { name: string }).name
    );
    expect(createdNames).toEqual(['Dup (1)', 'Dup (2)']);

    // Restarting the probe from 1 for every notebook is the O(N^2) regression this guards against:
    // with the per-run hint, the third notebook probes only "Dup (2)" instead of re-probing
    // "Dup (1)" first. One findExistingSession call per notebook (3) plus one generateUniqueName
    // probe each for the second and third notebook (2) is the bound - a regression to
    // restart-from-1 costs at least one more.
    expect(sessionRepository.find).toHaveBeenCalledTimes(5);
  });
});
