import { describe, expect, it, vi } from 'vitest';
import type { IAgentDocument } from '@bike4mind/common';
import { findUsableAttachedAgents } from './attachedAgents';

const agent = (id: string) => ({ id }) as IAgentDocument;

const repo = (readable: Record<string, string[]>) => ({
  shareable: {
    findAllAccessibleByIds: vi.fn(async (user: { id: string }, ids: string[]) =>
      ids.filter(id => (readable[user.id] ?? []).includes(id)).map(agent)
    ),
  },
});

describe('findUsableAttachedAgents', () => {
  it('drops an attached agent whose share was revoked from every viewer', async () => {
    const agents = repo({ sharee: ['kept'] });
    const usable = await findUsableAttachedAgents(['revoked', 'kept'], [{ id: 'sharee' }], agents as never);
    expect(usable.map(a => a.id)).toEqual(['kept']);
  });

  it('keeps an agent any viewer can read, in attachment order, without duplicates', async () => {
    const agents = repo({ owner: ['a', 'b'], collaborator: ['b'] });
    const usable = await findUsableAttachedAgents(
      ['b', 'a'],
      [{ id: 'collaborator' }, { id: 'owner' }, null],
      agents as never
    );
    expect(usable.map(a => a.id)).toEqual(['b', 'a']);
  });

  it('does not query for an empty list', async () => {
    const agents = repo({});
    expect(await findUsableAttachedAgents([], [{ id: 'u' }], agents as never)).toEqual([]);
    expect(agents.shareable.findAllAccessibleByIds).not.toHaveBeenCalled();
  });

  it('returns plain objects when the access query hydrates documents', async () => {
    const agents = repo({});
    agents.shareable.findAllAccessibleByIds.mockResolvedValue([
      { id: 'a', toJSON: () => ({ id: 'a', plain: true }) },
    ] as never);
    expect(await findUsableAttachedAgents(['a'], [{ id: 'u' }], agents as never)).toEqual([{ id: 'a', plain: true }]);
  });
});
