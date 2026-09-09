import { describe, it, expect, vi } from 'vitest';
import { NotebookExportService } from './index';
import type { NotebookExportAdapters } from './index';
import { NotebookImportService } from '../notebookImportService';
import type { NotebookImportAdapters } from '../notebookImportService';

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
    artifactContentRepository: none,
    toolRepository: none,
    agentRepository: none,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...over,
    // Merged rather than replaced, and placed after the spread so it wins: a test overriding
    // getFileContent alone still gets the uploadFile that captures the emitted file.
    fileStorageService: {
      getFileContent: vi.fn().mockResolvedValue(null),
      uploadFile: vi.fn(async (_path: string, content: Buffer) => {
        uploaded.push(content.toString('utf-8'));
      }),
      getSignedUrl: vi.fn().mockResolvedValue('https://example.test/export.json'),
      ...(over.fileStorageService as Record<string, unknown> | undefined),
    },
  } as unknown as NotebookExportAdapters;
  return { adapters, uploaded };
}

/**
 * The artifact query nests two `$or`s under `$and`: membership (by id or by sessionId) first,
 * access second. Reading each clause by position rather than matching the whole object is what
 * lets a test fail when one of them goes missing.
 */
type ArtifactClause = { id?: { $in?: string[] }; sessionId?: string };
type ArtifactQuery = { deletedAt?: null; $and?: { $or?: ArtifactClause[] }[] };
const membershipOf = (q: ArtifactQuery): ArtifactClause[] => q.$and?.[0]?.$or ?? [];
const accessOf = (q: ArtifactQuery) => q.$and?.[1]?.$or;

const GOOD = '507f1f77bcf86cd799439011';
const UPPER = '507F1F77BCF86CD799439011';

const OPTIONS = {
  format: 'json',
  includeMetadata: true,
  includeArtifacts: true,
  includeKnowledge: true,
  includeTools: true,
  includeAgents: true,
  // Matches the route's own default, so processImages runs here as it does in production.
  includeImages: true,
  maxFileSize: 1_000_000,
} as unknown as Parameters<NotebookExportService['exportNotebooks']>[1];

async function exportOnce(over: AdapterOverrides = {}) {
  const { adapters, uploaded } = makeAdapters(over);
  await new NotebookExportService(adapters).exportNotebooks('user-1', OPTIONS);
  expect(uploaded).toHaveLength(1);
  return JSON.parse(uploaded[0]);
}

/** Same run, but hands back the adapters so a test can assert on what was NOT logged. */
async function exportOnceWithAdapters(over: AdapterOverrides = {}) {
  const { adapters, uploaded } = makeAdapters(over);
  await new NotebookExportService(adapters).exportNotebooks('user-1', OPTIONS);
  expect(uploaded).toHaveLength(1);
  return { payload: JSON.parse(uploaded[0]), adapters };
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

  it('finds artifacts by their own id, not by _id', async () => {
    // Artifact ids are not ObjectId-castable, so the real collection throws on an `_id` query.
    const find = vi.fn(async (query: ArtifactQuery) => {
      const byId = membershipOf(query).find(c => c.id)?.id?.$in;
      if (!byId) {
        throw new Error('CastError: Cast to ObjectId failed for value "artifact_1_probe" at path "_id"');
      }
      return byId.map(id => ({ id, title: 'My Chart', type: 'recharts' }));
    });

    const payload = await exportOnce({ artifactRepository: { find } });

    expect(payload.notebooks[0].artifacts.map((a: { id: string }) => a.id)).toEqual(['artifact-1']);
  });

  it('exports an artifact linked only by its own sessionId, not listed in session.artifactIds', async () => {
    // The ordinary case, and the one that used to export nothing: an artifact generated in chat
    // records `sessionId` itself, while `session.artifactIds` is a denormalised copy only the
    // artifact viewer's save path writes. Keying on the array alone missed every such artifact.
    const find = vi.fn(async (query: ArtifactQuery) => {
      const bySession = membershipOf(query).find(c => c.sessionId)?.sessionId;
      return bySession === 'session-1' ? [{ id: 'artifact_chat_1', title: 'Red Circle', type: 'svg', version: 1 }] : [];
    });
    const contents = {
      find: vi.fn().mockResolvedValue([{ artifactId: 'artifact_chat_1', version: 1, content: '<svg/>' }]),
    };

    // Empty array: the session names no artifacts at all, so only the sessionId match can find it.
    const payload = await exportOnce({
      sessionRepository: { find: vi.fn().mockResolvedValue([{ ...SESSION, artifactIds: [] }]) },
      artifactRepository: { find },
      artifactContentRepository: contents,
    });

    expect(payload.notebooks[0].artifacts).toEqual([
      expect.objectContaining({ id: 'artifact_chat_1', name: 'Red Circle', content: '<svg/>' }),
    ]);
  });

  it('warns by id about an artifact it could not export, so the gap is not silent', async () => {
    const { adapters, uploaded } = makeAdapters({
      artifactRepository: { find: vi.fn().mockResolvedValue([]) },
    });
    await new NotebookExportService(adapters).exportNotebooks('user-1', OPTIONS);

    expect(uploaded).toHaveLength(1);
    expect(adapters.logger.warn).toHaveBeenCalledWith(
      'Some artifacts were not exported',
      expect.objectContaining({ notExported: ['artifact-1'] })
    );
  });

  it('leaves a soft-deleted artifact out of the export, like every other artifact reader', async () => {
    // What this pins is that the filter is SENT and that a matching row is excluded. It cannot
    // establish MongoDB's own null-matches-missing behaviour, which is what makes the filter safe
    // for the normal rows that have no `deletedAt` field at all - the repository here is a stub.
    // That half rests on the schema: `deletedAt` has no default, so those rows omit the field, and
    // an equality-to-null query matches missing-or-null.
    const find = vi.fn(async (query: Record<string, unknown>) => {
      // Mirrors the collection: a row whose deletedAt is set does not match `deletedAt: null`.
      if (query.deletedAt !== null) {
        return [{ id: 'artifact-1', title: 'Deleted Chart', type: 'recharts', deletedAt: new Date() }];
      }
      return [];
    });

    const payload = await exportOnce({ artifactRepository: { find } });

    expect(payload.notebooks[0].artifacts).toEqual([]);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ deletedAt: null }));
  });

  it('leaves out an artifact the exporter cannot read, and scopes the query to them', async () => {
    // `session.artifactIds` is client-supplied and written through unvalidated, so an id arriving
    // at the export is not necessarily the caller's. The normal read path denies such a row; the
    // export must not be the way around it. The stub answers only when the query carries the
    // access clause, so this cannot pass by resolving everything.
    const find = vi.fn().mockImplementation((query: ArtifactQuery) => {
      if (!accessOf(query)) return [{ id: 'artifact-1', title: 'Someone Elses Artifact', type: 'react' }];
      return [];
    });

    const payload = await exportOnce({ artifactRepository: { find } });

    expect(payload.notebooks[0].artifacts).toEqual([]);
    // Read off the sent query rather than matched loosely: the access clause and the membership
    // clause are both `$or`s nested under `$and`, and a regression that dropped either one would
    // still satisfy an `objectContaining` on the outer object.
    expect(accessOf(find.mock.calls[0][0])).toEqual([
      { userId: 'user-1' },
      { 'permissions.canRead': 'user-1' },
      { visibility: 'public' },
      { 'permissions.isPublic': true },
    ]);
  });

  it('exports the resolvable knowledge files even when a session holds a non-ObjectId knowledgeId', async () => {
    // FabFile is ObjectId-keyed, but session.knowledgeIds is a plain string array, so a junk
    // entry makes the real collection throw and (before this) killed the whole export.
    const find = vi.fn(async (query: Record<string, { $in?: string[] }>) => {
      const ids = query._id?.$in ?? [];
      const bad = ids.find(id => !/^[0-9a-fA-F]{24}$/.test(id));
      if (bad) {
        throw new Error(`CastError: Cast to ObjectId failed for value "${bad}" at path "_id"`);
      }
      return ids.map(id => ({ id, fileName: 'notes.txt', mimeType: 'text/plain', fileSize: 10 }));
    });

    // UPPER is here rather than in its own test: uppercase hex is a valid ObjectId rendering,
    // and the stub's regex is case-insensitive, so one fixture covers both.
    const payload = await exportOnce({
      sessionRepository: {
        find: vi.fn().mockResolvedValue([{ ...SESSION, knowledgeIds: ['not-an-objectid', GOOD, UPPER] }]),
      },
      knowledgeRepository: { find, findOne: vi.fn().mockResolvedValue(null) },
    });

    expect(payload.notebooks[0].knowledge.map((k: { id: string }) => k.id)).toEqual([GOOD, UPPER]);
  });

  it('warns by name about a knowledgeId it had to skip, so the gap is not silent', async () => {
    const { adapters, uploaded } = makeAdapters({
      sessionRepository: { find: vi.fn().mockResolvedValue([{ ...SESSION, knowledgeIds: ['not-an-objectid'] }]) },
    });
    await new NotebookExportService(adapters).exportNotebooks('user-1', OPTIONS);

    expect(uploaded).toHaveLength(1);
    expect(adapters.logger.warn).toHaveBeenCalledWith(expect.stringContaining('[knowledge]'), {
      skipped: ['not-an-objectid'],
    });
  });

  it.each(['tool', 'agent'])('drops a non-ObjectId %s id instead of failing the export', async kind => {
    // Same `_id` hazard as knowledge; these two are reachable via notebooks imported before the
    // id fix, which recorded uuids.
    const find = vi.fn(async (query: Record<string, { $in?: string[] }>) => {
      const ids = query._id?.$in ?? [];
      if (ids.some(id => !/^[0-9a-fA-F]{24}$/.test(id))) {
        throw new Error('CastError: Cast to ObjectId failed');
      }
      return ids.map(id => ({ id, name: `a ${kind} row` }));
    });

    const payload = await exportOnce({
      sessionRepository: {
        find: vi.fn().mockResolvedValue([{ ...SESSION, [`${kind}Ids`]: ['not-an-objectid', GOOD] }]),
      },
      [`${kind}Repository`]: { find },
    });

    expect(payload.notebooks[0][`${kind}s`].map((x: { id: string }) => x.id)).toEqual([GOOD]);
  });

  it('does not warn about a notebook that simply has no attachments', async () => {
    const { adapters } = makeAdapters({
      sessionRepository: {
        find: vi.fn().mockResolvedValue([{ ...SESSION, artifactIds: [], knowledgeIds: [], toolIds: [], agentIds: [] }]),
      },
    });
    await new NotebookExportService(adapters).exportNotebooks('user-1', OPTIONS);

    expect(adapters.logger.warn).not.toHaveBeenCalled();
  });

  it('names an artifact from its title, which is the field the entity actually has', async () => {
    const { payload, adapters } = await exportOnceWithAdapters({
      artifactRepository: {
        find: vi.fn().mockResolvedValue([{ id: 'artifact-1', title: 'My Chart', type: 'recharts', version: 1 }]),
      },
      artifactContentRepository: {
        find: vi.fn().mockResolvedValue([{ artifactId: 'artifact-1', version: 1, content: 'chart body' }]),
      },
    });

    expect(payload.notebooks[0].artifacts[0].name).toBe('My Chart');
    // An export where every id resolved must say nothing. Without this a spurious warn - the kind
    // an off-by-one in the notExported predicate produces - would ship green.
    expect(adapters.logger.warn).not.toHaveBeenCalled();
  });

  it('carries the artifact body, which is what makes the export importable at all', async () => {
    // Without this the import cannot derive contentId/contentHash/contentSize and rejects every
    // artifact, which is the whole failure this join exists to remove.
    const { payload, adapters } = await exportOnceWithAdapters({
      artifactRepository: {
        find: vi.fn().mockResolvedValue([{ id: 'artifact-1', title: 'My Chart', type: 'recharts', version: 3 }]),
      },
      artifactContentRepository: {
        find: vi.fn().mockResolvedValue([
          { artifactId: 'artifact-1', version: 3, content: 'current body' },
          { artifactId: 'artifact-1', version: 2, content: 'stale body' },
        ]),
      },
    });

    expect(payload.notebooks[0].artifacts[0].content).toBe('current body');
    // Newest-first is Mongo's job, not a re-sort here, so the sort is part of the contract.
    expect(adapters.artifactContentRepository.find).toHaveBeenCalledWith(
      { artifactId: { $in: ['artifact-1'] } },
      { sort: { version: -1 } }
    );
  });

  it('warns by id about an artifact whose body is missing rather than exporting it silently', async () => {
    const { payload, adapters } = await exportOnceWithAdapters({
      artifactRepository: {
        find: vi.fn().mockResolvedValue([{ id: 'artifact-1', title: 'My Chart', type: 'recharts', version: 1 }]),
      },
      artifactContentRepository: { find: vi.fn().mockResolvedValue([]) },
    });

    // Still exported, so the notebook lists what it had; the import is what refuses it. The warn is
    // what separates "the source had no body" from "the import lost it".
    expect(payload.notebooks[0].artifacts).toHaveLength(1);
    expect(payload.notebooks[0].artifacts[0].content).toBeUndefined();
    expect(adapters.logger.warn).toHaveBeenCalledWith(
      'Some artifacts exported without their body',
      expect.objectContaining({ artifactIds: ['artifact-1'] })
    );
  });
  it('exports the body the viewer shows when the artifact pointer lags its content rows', async () => {
    // The only drift that can actually happen: `update` writes the content row first and assigns
    // `artifact.version` only after, with no transaction around the pair, so an interrupted write
    // leaves the pointer BEHIND the newest row. The viewer resolves through findLatestContent and
    // renders v3; a join keyed on `artifact.version` finds the (id, 2) row and silently exports v2.
    const { payload, adapters } = await exportOnceWithAdapters({
      artifactRepository: {
        find: vi.fn().mockResolvedValue([{ id: 'artifact-1', title: 'My Chart', type: 'recharts', version: 2 }]),
      },
      artifactContentRepository: {
        find: vi.fn().mockResolvedValue([
          { artifactId: 'artifact-1', version: 3, content: 'what the viewer shows' },
          { artifactId: 'artifact-1', version: 2, content: 'what the pointer says' },
        ]),
      },
    });

    expect(payload.notebooks[0].artifacts[0].content).toBe('what the viewer shows');
    expect(adapters.logger.warn).not.toHaveBeenCalledWith(
      'Some artifacts exported without their body',
      expect.anything()
    );
  });
});

describe('notebook export - notebookIds shape', () => {
  it('rejects an id that cannot address a notebook instead of letting Mongo throw', async () => {
    const { adapters } = makeAdapters();
    const svc = new NotebookExportService(adapters);

    await expect(
      svc.exportNotebooks('user-1', { ...OPTIONS, notebookIds: ['not-an-objectid'] } as never)
    ).rejects.toMatchObject({ code: 'INVALID_NOTEBOOK_ID' });

    // Never dropped: the whole point is that the caller is told, not that fewer notebooks ship.
    expect(adapters.sessionRepository.find).not.toHaveBeenCalled();
  });

  it('names the offending id, so the 400 is actionable', async () => {
    const svc = new NotebookExportService(makeAdapters().adapters);

    await expect(
      svc.exportNotebooks('user-1', { ...OPTIONS, notebookIds: [GOOD, 'legacy-uuid'] } as never)
    ).rejects.toThrow(/legacy-uuid/);
  });

  it('accepts uppercase hex, which addresses the same row', async () => {
    const { adapters } = makeAdapters();
    await new NotebookExportService(adapters).exportNotebooks('user-1', {
      ...OPTIONS,
      notebookIds: [UPPER],
    } as never);

    expect(adapters.sessionRepository.find).toHaveBeenCalledWith(expect.objectContaining({ _id: { $in: [UPPER] } }));
  });

  it('anchors a date-only fromDate to midnight and stretches a date-only toDate to end of day', async () => {
    // `new Date('2026-01-20')` is that day at 00:00Z, so an inclusive `$lte` on it returns nothing
    // from the day the caller named. The modal resolves the picked day itself, so this form is what
    // an API caller sends.
    const { adapters } = makeAdapters();
    await new NotebookExportService(adapters).exportNotebooks('user-1', {
      ...OPTIONS,
      fromDate: '2026-01-15',
      toDate: '2026-01-20',
    } as never);

    expect(adapters.sessionRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        lastUpdated: {
          $gte: new Date('2026-01-15T00:00:00.000Z'),
          $lte: new Date('2026-01-20T23:59:59.999Z'),
        },
      })
    );
  });

  it('leaves a full ISO datetime toDate exactly where the caller put it', async () => {
    const { adapters } = makeAdapters();
    await new NotebookExportService(adapters).exportNotebooks('user-1', {
      ...OPTIONS,
      toDate: '2026-01-20T08:30:00.000Z',
    } as never);

    expect(adapters.sessionRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({ lastUpdated: { $lte: new Date('2026-01-20T08:30:00.000Z') } })
    );
  });
});

describe('notebook export - log level', () => {
  // The reason the status mapping exists at all: a 5xx-level line trips the CloudWatch filter and
  // pages LiveOps. Answering 404 at the route is not enough if the service already logged `error`.
  it('reports NO_NOTEBOOKS carrying a 404, and logs it at warn rather than error', async () => {
    const { adapters } = makeAdapters({ sessionRepository: { find: vi.fn().mockResolvedValue([]) } });

    await expect(new NotebookExportService(adapters).exportNotebooks('user-1', OPTIONS)).rejects.toMatchObject({
      code: 'NO_NOTEBOOKS',
      statusCode: 404,
    });

    expect(adapters.logger.error).not.toHaveBeenCalled();
    expect(adapters.logger.warn).toHaveBeenCalledWith(
      'Notebook export rejected',
      expect.objectContaining({ code: 'NO_NOTEBOOKS' })
    );
  });

  it('reports INVALID_NOTEBOOK_ID carrying a 400, and logs it at warn too', async () => {
    const { adapters } = makeAdapters();

    await expect(
      new NotebookExportService(adapters).exportNotebooks('user-1', {
        ...OPTIONS,
        notebookIds: ['not-an-objectid'],
      } as never)
    ).rejects.toMatchObject({ code: 'INVALID_NOTEBOOK_ID', statusCode: 400 });

    expect(adapters.logger.error).not.toHaveBeenCalled();
    expect(adapters.logger.warn).toHaveBeenCalledWith(
      'Notebook export rejected',
      expect.objectContaining({
        code: 'INVALID_NOTEBOOK_ID',
        status: 400,
        // The ids are the only actionable part of this line; they exist nowhere else in any log.
        reason: expect.stringContaining('not-an-objectid'),
      })
    );
  });

  it('still logs an unexpected fault at error, so a real break stays loud', async () => {
    const { adapters } = makeAdapters({
      sessionRepository: { find: vi.fn().mockRejectedValue(new Error('mongo is on fire')) },
    });

    await expect(new NotebookExportService(adapters).exportNotebooks('user-1', OPTIONS)).rejects.toMatchObject({
      code: 'EXPORT_FAILED',
    });

    expect(adapters.logger.error).toHaveBeenCalled();
  });
});

/**
 * A real PDF header followed by bytes that are not valid UTF-8. Decoding these into a string
 * before base64 replaces each one with U+FFFD, and no downstream consumer can undo that - the
 * bytes are gone by the time base64 runs.
 */
const PDF_BYTES = Buffer.from([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10,
]);

/** Escaped rather than literal: this file is ASCII-only, and the multi-byte run is the point. */
const TEXT_BYTES = Buffer.from('notes with an accent: caf\u00e9 and a snowman \u2603\n', 'utf-8');

const PDF_FILE = {
  id: GOOD,
  fileName: 'report.pdf',
  fileSize: PDF_BYTES.length,
  mimeType: 'application/pdf',
  type: 'FILE',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  filePath: 'knowledge/user-1/report.pdf',
  fileUrl: 'https://example.test/report.pdf',
  // isImageServeable gates every mime type on moderationStatus, images or not.
  moderationStatus: 'clean',
};

const TEXT_FILE = { ...PDF_FILE, fileName: 'notes.txt', mimeType: 'text/plain', fileSize: TEXT_BYTES.length };

async function exportWithKnowledge(bytes: Buffer, file: Record<string, unknown> = PDF_FILE) {
  return exportOnce({
    sessionRepository: { find: vi.fn().mockResolvedValue([{ ...SESSION, knowledgeIds: [GOOD] }]) },
    knowledgeRepository: {
      find: vi.fn().mockResolvedValue([file]),
      findOne: vi.fn().mockResolvedValue(null),
    },
    fileStorageService: { getFileContent: vi.fn().mockResolvedValue(bytes) },
  });
}

describe('notebook export - knowledge file bytes', () => {
  it('embeds a binary knowledge file as base64 that decodes back byte-identical', async () => {
    const payload = await exportWithKnowledge(PDF_BYTES);
    const [knowledge] = payload.notebooks[0].knowledge;

    // Compared against the fixture, not against a re-run of the production expression, so an
    // encoder that mangles the bytes cannot satisfy this by mangling both sides the same way.
    expect(Buffer.from(knowledge.content, 'base64').equals(PDF_BYTES)).toBe(true);
  });

  // The branch the `!== null` change deliberately rewrote, pinned in both directions. A zero-byte
  // file now embeds an empty `content` where it used to emit a `contentUrl` reference, because an
  // empty Buffer is truthy while the empty string it replaced was falsy. Neither shape round trips
  // (the import cannot tell empty-but-present from absent), so this records what the export emits
  // rather than blessing it.
  it('embeds an empty knowledge file as empty content, not a url reference', async () => {
    const payload = await exportWithKnowledge(Buffer.alloc(0));
    const [knowledge] = payload.notebooks[0].knowledge;

    expect(knowledge.content).toBe('');
    expect(knowledge.contentUrl).toBeUndefined();
  });

  it('embeds a UTF-8 text file unchanged', async () => {
    const payload = await exportWithKnowledge(TEXT_BYTES, TEXT_FILE);
    const [knowledge] = payload.notebooks[0].knowledge;

    expect(Buffer.from(knowledge.content, 'base64').toString('utf-8')).toBe(TEXT_BYTES.toString('utf-8'));
  });

  it('round trips a binary knowledge file through import with the stored bytes intact', async () => {
    const payload = await exportWithKnowledge(PDF_BYTES);

    const uploads: Buffer[] = [];
    const importAdapters = {
      sessionRepository: {
        find: vi.fn().mockResolvedValue([]),
        create: vi.fn(async (data: Record<string, unknown>) => ({ ...data, id: 'new-session-id' })),
        updateById: vi.fn(),
      },
      chatHistoryRepository: { bulkCreate: vi.fn(), deleteMany: vi.fn() },
      knowledgeRepository: { create: vi.fn().mockResolvedValue({ id: 'new-knowledge-id' }) },
      artifactRepository: { create: vi.fn() },
      toolRepository: { create: vi.fn(), find: vi.fn(), findById: vi.fn() },
      agentRepository: { create: vi.fn() },
      userRepository: { findById: vi.fn().mockResolvedValue({ id: 'user-2' }) },
      fileStorageService: {
        uploadFile: vi.fn(async (_path: string, content: Buffer) => {
          uploads.push(content);
        }),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      generateId: () => 'generated-id',
    } as unknown as NotebookImportAdapters;

    const result = await new NotebookImportService(importAdapters).importNotebooks('user-2', payload, {
      conflictResolution: 'rename',
      importKnowledge: true,
      importArtifacts: false,
      importTools: false,
      importAgents: false,
    } as never);

    expect(result.warnings).toEqual([]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].equals(PDF_BYTES)).toBe(true);
  });
});

describe('notebook export - image bytes', () => {
  async function exportWithImage(bytes: Buffer | null) {
    return exportOnce({
      chatHistoryRepository: {
        find: vi
          .fn()
          .mockResolvedValueOnce([
            { id: 'msg-1', timestamp: new Date('2026-01-01T00:00:00Z'), images: ['images/user-1/shot.png'] },
          ])
          .mockResolvedValue([]),
      },
      fileStorageService: { getFileContent: vi.fn().mockResolvedValue(bytes) },
    });
  }

  it('embeds an image as base64 that decodes back byte-identical', async () => {
    // Same guard as the knowledge path: this call site encodes separately, so it needs its own
    // fixture comparison rather than inheriting the other one's coverage.
    const payload = await exportWithImage(PDF_BYTES);
    const [image] = payload.notebooks[0].chatHistory[0].images;

    expect(Buffer.from(image, 'base64').equals(PDF_BYTES)).toBe(true);
  });

  // Pins CURRENT, KNOWN-BROKEN behaviour, not desired behaviour: `images` is a flat string[] that
  // holds base64 on success and a raw storage path on failure, with nothing to tell them apart, so
  // a consumer decoding every element gets plausible garbage from the path entries (Node's base64
  // decoder does not reject them). Giving images the content/contentUrl split knowledge files
  // already have is the fix; when that lands, this expectation SHOULD change - it is not a
  // regression guard for the string[] shape.
  it('exports the path instead when the image cannot be read', async () => {
    const payload = await exportWithImage(null);

    expect(payload.notebooks[0].chatHistory[0].images).toEqual(['images/user-1/shot.png']);
  });
});
