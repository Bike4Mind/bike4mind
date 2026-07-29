import { describe, expect, it, vi } from 'vitest';
import { resolveLakeMembershipScope } from './lakeMembershipScope';

const lake = {
  datalakeTag: 'datalake:org1:acme-docs',
  fileTagPrefix: 'acme:',
  createdByUserId: 'creator-1',
};

const adapters = (findById: ReturnType<typeof vi.fn>) => {
  const logger = { warn: vi.fn() };
  return { deps: { db: { users: { findById } }, logger }, logger };
};

describe('resolveLakeMembershipScope', () => {
  it('carries the meta-tag, prefix, creator and the creator groups', async () => {
    const { deps, logger } = adapters(vi.fn().mockResolvedValue({ groups: ['g1', 'g2'] }));

    const scope = await resolveLakeMembershipScope(lake, deps);

    expect(scope).toEqual({
      datalakeTag: 'datalake:org1:acme-docs',
      fileTagPrefix: 'acme:',
      creatorUserId: 'creator-1',
      creatorGroupIds: ['g1', 'g2'],
    });
    // A healthy lake must stay silent, or the warning below becomes noise nobody reads.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('normalizes a creator with null groups to an empty list without warning', async () => {
    const { deps, logger } = adapters(vi.fn().mockResolvedValue({ groups: null }));

    const scope = await resolveLakeMembershipScope(lake, deps);

    expect(scope.creatorGroupIds).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and drops the group arm when the creator record is gone', async () => {
    const { deps, logger } = adapters(vi.fn().mockResolvedValue(null));

    const scope = await resolveLakeMembershipScope(lake, deps);

    expect(scope.creatorGroupIds).toBeUndefined();
    expect(scope.creatorUserId).toBe('creator-1');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('warns and stays usable when the user read throws', async () => {
    const { deps, logger } = adapters(vi.fn().mockRejectedValue(new Error('mongo down')));

    const scope = await resolveLakeMembershipScope(lake, deps);

    expect(scope.datalakeTag).toBe('datalake:org1:acme-docs');
    expect(scope.creatorGroupIds).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('warns without querying when the lake has no creator', async () => {
    const findById = vi.fn();
    const { deps, logger } = adapters(findById);

    const scope = await resolveLakeMembershipScope({ ...lake, createdByUserId: '' }, deps);

    expect(findById).not.toHaveBeenCalled();
    expect(scope.creatorUserId).toBe('');
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
