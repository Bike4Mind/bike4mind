import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachOrganizationLogos } from './attachOrganizationLogos';

const find = vi.hoisted(() => vi.fn());
const files = vi.hoisted(() => ({ value: [] as { _id: string; path: string }[] }));

vi.mock('@bike4mind/database/content', () => ({
  AppFile: {
    find: (...args: unknown[]) => {
      find(...args);
      return { select: () => ({ lean: async () => files.value }) };
    },
  },
}));

describe('attachOrganizationLogos', () => {
  beforeEach(() => {
    find.mockReset();
    files.value = [];
  });

  it('does not query when no organization has a logo', async () => {
    const orgs = [{ id: 'a' }, null];
    expect(await attachOrganizationLogos(orgs)).toBe(orgs);
    expect(find).not.toHaveBeenCalled();
  });

  it('attaches id and path in one query, and leaves an org whose file is missing alone', async () => {
    files.value = [{ _id: 'f1', path: 'organizations/a/x.png' }];
    const result = await attachOrganizationLogos([
      { id: 'a', logoFileId: 'f1' },
      { id: 'b', logoFileId: 'f1' },
      { id: 'c', logoFileId: 'gone' },
      { id: 'd' },
    ]);

    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({ _id: { $in: ['f1', 'gone'] } });
    expect(result).toEqual([
      { id: 'a', logoFileId: 'f1', logo: { id: 'f1', path: 'organizations/a/x.png' } },
      { id: 'b', logoFileId: 'f1', logo: { id: 'f1', path: 'organizations/a/x.png' } },
      { id: 'c', logoFileId: 'gone' },
      { id: 'd' },
    ]);
  });
});
