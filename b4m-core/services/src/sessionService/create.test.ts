import { describe, it, expect, vi } from 'vitest';
import { createSession } from './create';
import type { CreateSessionAdapters } from './create';
import type { IUserDocument } from '@bike4mind/common';

/**
 * Lake-scope derivation at create time. The behavior under test is why an empty `retrievalTags` is
 * dangerous rather than merely unset: the search's tag clause is skipped entirely for an empty list,
 * so a session that names no lake retrieves against every lake its owner can reach.
 */
describe('createSession lake-scope derivation', () => {
  const user = { id: 'u1' } as IUserDocument;

  // ObjectId-shaped on purpose: createSession drops knowledgeIds that cannot address a row before
  // deriving, because findAllAccessibleByIds queries `_id: { $in: ... }` and a bad id throws there.
  const FILE_A = '507f1f77bcf86cd799439001';
  const FILE_B = '507f1f77bcf86cd799439002';
  const OTHER_FILE = '507f1f77bcf86cd799439003';

  const makeAdapters = (files: unknown[]) => {
    const findAllAccessibleByIds = vi.fn().mockResolvedValue(files);
    return {
      adapters: {
        db: {
          sessions: { create: vi.fn(async (d: unknown) => ({ id: 's1', ...(d as object) })) },
          projects: {} as never,
          fabFiles: { shareable: { findAllAccessibleByIds } } as never,
        },
      },
      findAllAccessibleByIds,
    };
  };

  const lakeFile = {
    id: FILE_A,
    tags: [{ name: 'datalake:acme' }, { name: 'acme:type:spec' }],
  };
  const personalFile = { id: FILE_B, tags: [{ name: 'notes' }] };

  it('derives the lake tag from the files a session is born holding', async () => {
    const { adapters } = makeAdapters([lakeFile]);
    const session = await createSession(user, { name: 'n', knowledgeIds: [FILE_A] }, adapters as never);
    expect(session.retrievalTags).toEqual(['datalake:acme']);
  });

  it('derives nothing from personal files, so a personal notebook stays unscoped', async () => {
    const { adapters } = makeAdapters([personalFile]);
    const session = await createSession(user, { name: 'n', knowledgeIds: [FILE_B] }, adapters as never);
    expect(session.retrievalTags).toBeUndefined();
  });

  it('leaves an explicitly-resolved lake scope alone (resolveLakeSessionDefaults is authoritative)', async () => {
    const { adapters, findAllAccessibleByIds } = makeAdapters([lakeFile]);
    const session = await createSession(
      user,
      { name: 'n', knowledgeIds: [FILE_A], retrievalTags: ['datalake:chosen'] },
      adapters as never
    );
    expect(session.retrievalTags).toEqual(['datalake:chosen']);
    // Not merely overridden - the derivation must not run at all, or it costs a DB read per create.
    expect(findAllAccessibleByIds).not.toHaveBeenCalled();
  });

  it('skips the lookup entirely when no files are attached', async () => {
    const { adapters, findAllAccessibleByIds } = makeAdapters([]);
    await createSession(user, { name: 'n' }, adapters as never);
    expect(findAllAccessibleByIds).not.toHaveBeenCalled();
  });

  it('resolves ids through the PERMISSION-FILTERED reader - knowledgeIds is client-writable', async () => {
    const { adapters, findAllAccessibleByIds } = makeAdapters([lakeFile]);
    await createSession(user, { name: 'n', knowledgeIds: [FILE_A, OTHER_FILE] }, adapters as never);
    expect(findAllAccessibleByIds).toHaveBeenCalledWith(user, [FILE_A, OTHER_FILE]);
  });

  it('never fails session creation when the lake lookup throws', async () => {
    const { adapters } = makeAdapters([]);
    adapters.db.fabFiles.shareable.findAllAccessibleByIds = vi.fn().mockRejectedValue(new Error('boom'));
    const session = await createSession(user, { name: 'n', knowledgeIds: [FILE_A] }, adapters as never);
    expect(session.retrievalTags).toBeUndefined();
  });
});

describe('createSession knowledgeIds validation', () => {
  const user = { id: '67cbd75e2415ca84138fada7' } as IUserDocument;
  const GOOD = '507f1f77bcf86cd799439011';

  function makeAdapters() {
    const created: Record<string, unknown>[] = [];
    const adapters = {
      db: {
        sessions: {
          create: vi.fn(async (data: Record<string, unknown>) => {
            created.push(data);
            return { ...data, id: 'session-1' };
          }),
        },
        projects: {},
        fabFiles: { shareable: { findAllAccessibleByIds: vi.fn().mockResolvedValue([]) } },
      },
    } as unknown as CreateSessionAdapters;
    return { adapters, created };
  }

  it('accepts an ObjectId-shaped knowledgeId', async () => {
    const { adapters, created } = makeAdapters();
    await createSession(user, { name: 'ok', knowledgeIds: [GOOD] }, adapters);
    expect(created[0].knowledgeIds).toEqual([GOOD]);
  });

  /**
   * Dropped, not rejected: /api/ai/llm forwards client-supplied fabFileIds straight into session
   * creation, so throwing here would fail the whole chat request over one unusable id.
   */
  it('drops an unusable knowledgeId and still creates', async () => {
    const { adapters, created } = makeAdapters();
    await createSession(user, { name: 'ok', knowledgeIds: ['legacy-uuid-not-an-objectid', GOOD] }, adapters);
    expect(created[0].knowledgeIds).toEqual([GOOD]);
  });

  // agentIds references the same ObjectId-keyed collection and is client-supplied on this path,
  // so leaving it unguarded beside a guarded knowledgeIds was arbitrary.
  it('drops an unusable agentId too, not just knowledgeIds', async () => {
    const { adapters, created } = makeAdapters();
    await createSession(user, { name: 'ok', agentIds: ['legacy-uuid-not-an-objectid', GOOD] }, adapters);
    expect(created[0].agentIds).toEqual([GOOD]);
  });

  it('leaves artifactIds alone, since those are a different id space', async () => {
    const { adapters, created } = makeAdapters();
    await createSession(user, { name: 'ok', artifactIds: ['artifact_1756000000_ab12cd'] }, adapters);
    expect(created[0].artifactIds).toEqual(['artifact_1756000000_ab12cd']);
  });
});
