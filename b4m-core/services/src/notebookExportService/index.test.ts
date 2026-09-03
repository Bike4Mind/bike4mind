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
    artifactContentRepository: none,
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
    const { payload } = await exportOnceWithAdapters({
      artifactRepository: {
        find: vi.fn().mockResolvedValue([{ id: 'artifact-1', title: 'My Chart', type: 'recharts', version: 3 }]),
      },
      artifactContentRepository: {
        // Current version first, stale second, so a key that ignored the version would take the
        // stale row by last-write-wins instead of quietly landing on the right answer.
        find: vi.fn().mockResolvedValue([
          { artifactId: 'artifact-1', version: 3, content: 'current body' },
          { artifactId: 'artifact-1', version: 2, content: 'stale body' },
        ]),
      },
    });

    // Keyed by version, not just by artifact: a stale row would export content the source no
    // longer shows.
    expect(payload.notebooks[0].artifacts[0].content).toBe('current body');
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
});
