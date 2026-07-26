import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

// Mock only `getCachedSignedUrl` from `@bike4mind/utils`; everything else (NotFoundError,
// secureParameters, etc.) stays real so `updateSession`'s validation/lookup logic still runs.
vi.mock('@bike4mind/utils', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/utils')>('@bike4mind/utils');
  return {
    ...actual,
    getCachedSignedUrl: vi.fn().mockResolvedValue('https://signed.example/fake-url'),
  };
});

import { updateSession } from './update';
import { getCachedSignedUrl } from '@bike4mind/utils';
import { IUserDocument } from '@bike4mind/common';

describe('updateSession — signed-URL cache pre-warm gate', () => {
  const user = { id: 'user-1' } as IUserDocument;

  const makeAdapters = (files: Array<Record<string, unknown>>) => ({
    db: {
      sessions: {
        shareable: {
          findUpdateAccessById: vi.fn().mockResolvedValue({
            id: 'session-1',
            knowledgeIds: [],
            artifactIds: [],
            tags: [],
            name: 'Session',
          }),
        },
        update: vi.fn(),
      },
      projects: {
        // Empty so the per-project `updateShareableFiles` loop is a no-op; this test only
        // exercises the cache pre-warm step above it.
        findAllBySessionId: vi.fn().mockResolvedValue([]),
      },
      fabFiles: {
        findAllByIds: vi.fn().mockResolvedValue(files),
      },
      caches: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal adapter shape for this unit test
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- storage isn't exercised; getCachedSignedUrl is mocked above
    storage: {} as any,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips pre-warming the cache for pending/blocked/not-yet-cleared files but warms clean images and clean non-images', async () => {
    const files = [
      { id: 'f-clean', filePath: 'path/clean.png', mimeType: 'image/png', moderationStatus: 'clean' },
      { id: 'f-pending', filePath: 'path/pending.png', mimeType: 'image/png', moderationStatus: 'pending' },
      { id: 'f-blocked', filePath: 'path/blocked.png', mimeType: 'image/png', moderationStatus: 'blocked' },
      { id: 'f-undefined-status', filePath: 'path/mid-scan.png', mimeType: 'image/png' },
      { id: 'f-doc', filePath: 'path/doc.pdf', mimeType: 'application/pdf', moderationStatus: 'clean' },
      // isImageServeable gates on moderationStatus alone (no mimeType special-case):
      // a non-image with an unset moderationStatus is held exactly like an image, since
      // the declared mimeType is client-controlled and only corrected by the async
      // S3-event scan.
      { id: 'f-doc-unset-status', filePath: 'path/mid-scan.pdf', mimeType: 'application/pdf' },
    ];
    const adapters = makeAdapters(files);

    await updateSession(
      user,
      {
        id: 'session-1',
        knowledgeIds: ['f-clean', 'f-pending', 'f-blocked', 'f-undefined-status', 'f-doc', 'f-doc-unset-status'],
      },
      adapters
    );

    const cachedPaths = (getCachedSignedUrl as Mock).mock.calls.map(call => call[0]);
    expect(cachedPaths.sort()).toEqual(['path/clean.png', 'path/doc.pdf']);
  });
});

describe('updateSession - forceKnowledgeRetrieval passthrough', () => {
  const user = { id: 'user-1' } as IUserDocument;

  const makeAdapters = (existing: Record<string, unknown>) => {
    const update = vi.fn();
    return {
      update,
      adapters: {
        db: {
          sessions: {
            shareable: {
              findUpdateAccessById: vi.fn().mockResolvedValue({
                id: 'session-1',
                knowledgeIds: [],
                artifactIds: [],
                tags: [],
                name: 'Session',
                ...existing,
              }),
            },
            update,
          },
          projects: { findAllBySessionId: vi.fn().mockResolvedValue([]) },
          fabFiles: { findAllByIds: vi.fn().mockResolvedValue([]) },
          caches: {},
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal adapter shape for this unit test
        } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- storage isn't exercised here
        storage: {} as any,
      },
    };
  };

  beforeEach(() => vi.clearAllMocks());

  it('persists forceKnowledgeRetrieval: true onto the session', async () => {
    const { update, adapters } = makeAdapters({ forceKnowledgeRetrieval: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the new schema field before types settle
    await updateSession(user, { id: 'session-1', forceKnowledgeRetrieval: true } as any, adapters);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({ forceKnowledgeRetrieval: true });
  });

  it('persists forceKnowledgeRetrieval: false (toggling off), not the old truthy value', async () => {
    const { update, adapters } = makeAdapters({ forceKnowledgeRetrieval: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the new schema field before types settle
    await updateSession(user, { id: 'session-1', forceKnowledgeRetrieval: false } as any, adapters);
    expect(update.mock.calls[0][0]).toMatchObject({ forceKnowledgeRetrieval: false });
  });

  it('leaves forceKnowledgeRetrieval untouched when the field is omitted', async () => {
    const { update, adapters } = makeAdapters({ forceKnowledgeRetrieval: true });
    await updateSession(user, { id: 'session-1', name: 'Renamed' }, adapters);
    expect(update.mock.calls[0][0]).toMatchObject({ forceKnowledgeRetrieval: true, name: 'Renamed' });
  });
});
