import { describe, it, expect, vi } from 'vitest';
import { createSession } from './create';
import type { IUserDocument } from '@bike4mind/common';

/**
 * Lake-scope derivation at create time. The behavior under test is why an empty `retrievalTags` is
 * dangerous rather than merely unset: the search's tag clause is skipped entirely for an empty list,
 * so a session that names no lake retrieves against every lake its owner can reach.
 */
describe('createSession lake-scope derivation', () => {
  const user = { id: 'u1' } as IUserDocument;

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
    id: 'f1',
    tags: [{ name: 'datalake:acme' }, { name: 'acme:type:spec' }],
  };
  const personalFile = { id: 'f2', tags: [{ name: 'notes' }] };

  it('derives the lake tag from the files a session is born holding', async () => {
    const { adapters } = makeAdapters([lakeFile]);
    const session = await createSession(user, { name: 'n', knowledgeIds: ['f1'] }, adapters as never);
    expect(session.retrievalTags).toEqual(['datalake:acme']);
  });

  it('derives nothing from personal files, so a personal notebook stays unscoped', async () => {
    const { adapters } = makeAdapters([personalFile]);
    const session = await createSession(user, { name: 'n', knowledgeIds: ['f2'] }, adapters as never);
    expect(session.retrievalTags).toBeUndefined();
  });

  it('leaves an explicitly-resolved lake scope alone (resolveLakeSessionDefaults is authoritative)', async () => {
    const { adapters, findAllAccessibleByIds } = makeAdapters([lakeFile]);
    const session = await createSession(
      user,
      { name: 'n', knowledgeIds: ['f1'], retrievalTags: ['datalake:chosen'] },
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
    await createSession(user, { name: 'n', knowledgeIds: ['f1', 'not-mine'] }, adapters as never);
    expect(findAllAccessibleByIds).toHaveBeenCalledWith(user, ['f1', 'not-mine']);
  });

  it('never fails session creation when the lake lookup throws', async () => {
    const { adapters } = makeAdapters([]);
    adapters.db.fabFiles.shareable.findAllAccessibleByIds = vi.fn().mockRejectedValue(new Error('boom'));
    const session = await createSession(user, { name: 'n', knowledgeIds: ['f1'] }, adapters as never);
    expect(session.retrievalTags).toBeUndefined();
  });
});
