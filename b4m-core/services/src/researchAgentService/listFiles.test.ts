import { describe, it, expect, vi } from 'vitest';
import type { IFabFileDocument } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { listFiles } from './listFiles';

const build = (files: Array<Partial<IFabFileDocument>>) => {
  const db = {
    researchAgents: { findByIdAndUserId: vi.fn().mockResolvedValue({ id: 'agent-1', userId: 'owner' }) },
    researchDatas: {
      findAllByResearchAgentId: vi.fn().mockResolvedValue(files.map((f, i) => ({ id: `rd-${i}`, fabFileId: f.id }))),
    },
    fabFiles: { findAllByIds: vi.fn().mockResolvedValue(files) },
  };
  return db as unknown as Parameters<typeof listFiles>[2]['db'];
};

describe('researchAgentService.listFiles', () => {
  it("returns only the agent owner's files, dropping a row that links another user's file", async () => {
    const db = build([
      { id: 'own', userId: 'owner' },
      { id: 'foreign', userId: 'someone-else' },
    ]);

    const files = await listFiles({ id: 'owner' }, { id: 'agent-1' }, { db });

    expect(files.map(f => f.id)).toEqual(['own']);
  });

  it('refuses an agent the caller does not own', async () => {
    const db = build([]);
    vi.mocked(db.researchAgents.findByIdAndUserId).mockResolvedValue(null);

    await expect(listFiles({ id: 'intruder' }, { id: 'agent-1' }, { db })).rejects.toThrow(NotFoundError);
  });
});
