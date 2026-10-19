import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IFabFileDocument } from '@bike4mind/common';

const { mockGetFabFile } = vi.hoisted(() => ({ mockGetFabFile: vi.fn() }));
vi.mock('./get', () => ({ getFabFile: mockGetFabFile }));

import { listFabFilesBySession } from './listBySession';

const file = (id: string) => ({ id }) as IFabFileDocument;

function makeAdapters(opts: { knowledge?: string[]; chatFiles?: string[][]; generated?: IFabFileDocument[] }) {
  const findAllByIds = vi.fn(async (ids: string[]) => ids.map(file));
  const findToolGeneratedBySessionId = vi.fn(async () => opts.generated ?? []);
  return {
    findAllByIds,
    findToolGeneratedBySessionId,
    adapters: {
      db: {
        users: { findById: vi.fn(async () => ({ id: 'u1' })) },
        sessions: {
          shareable: { findAccessibleById: vi.fn(async () => ({ id: 's1', knowledgeIds: opts.knowledge ?? [] })) },
        },
        chatHistories: {
          findAllBySessionId: vi.fn(async () => (opts.chatFiles ?? []).map(fabFileIds => ({ fabFileIds }))),
        },
        fabFiles: { findAllByIds, findToolGeneratedBySessionId },
        adminSettings: {},
      },
      storage: { generateSignedUrl: vi.fn() },
    } as unknown as Parameters<typeof listFabFilesBySession>[2],
  };
}

describe('listFabFilesBySession', () => {
  beforeEach(() => {
    mockGetFabFile.mockReset();
    mockGetFabFile.mockImplementation(async (_userId: string, { id }: { id: string }) => file(id));
  });

  it('includes files an in-chat tool generated in the session alongside attached files', async () => {
    const { adapters, findToolGeneratedBySessionId } = makeAdapters({
      knowledge: ['k1'],
      chatFiles: [['c1']],
      generated: [file('gen-audio'), file('gen-image')],
    });

    const result = await listFabFilesBySession('u1', { sessionId: 's1' }, adapters);

    expect(findToolGeneratedBySessionId).toHaveBeenCalledWith('s1');
    expect(result.map(f => f.id)).toEqual(['k1', 'c1', 'gen-audio', 'gen-image']);
  });

  it('does not list a generated file twice when it is also attached to the session', async () => {
    const { adapters } = makeAdapters({ knowledge: ['gen-image'], generated: [file('gen-image')] });

    const result = await listFabFilesBySession('u1', { sessionId: 's1' }, adapters);

    expect(result.map(f => f.id)).toEqual(['gen-image']);
  });
});
