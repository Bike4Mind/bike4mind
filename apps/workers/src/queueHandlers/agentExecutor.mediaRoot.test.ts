import { describe, expect, it, vi } from 'vitest';
import { resolveMediaRoot } from './agentExecutor.mediaRoot';

const root = { id: 'root', userId: 'u', sessionId: 's', organizationId: 'o' };
const child = { ...root, id: 'child', parentExecutionId: 'root' };

describe('resolveMediaRoot', () => {
  it('resolves dispatched descendants and background children to the shared root', async () => {
    const read = vi.fn(async (id: string) => (id === 'child' ? child : root));
    expect(await resolveMediaRoot({ ...root, id: 'grandchild', spawnedByExecutionId: 'child' }, read)).toEqual(root);
    expect(read.mock.calls).toEqual([['child'], ['root']]);
  });

  it('fails closed for missing, cyclic, or cross-scope ancestry', async () => {
    for (const parent of [
      null,
      child,
      { ...root, userId: 'other' },
      { ...root, sessionId: 'other' },
      { ...root, organizationId: 'other' },
    ]) {
      expect(await resolveMediaRoot(child, async () => parent)).toBeUndefined();
    }
  });
});
