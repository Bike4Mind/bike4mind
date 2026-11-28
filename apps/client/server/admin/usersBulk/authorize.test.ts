import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@bike4mind/common';

const mockRequire = vi.fn();

vi.mock('@server/middlewares/adminApi', () => ({ requireAdminPermission: (...a: unknown[]) => mockRequire(...a) }));
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  dataLakeRepository: { findGateValues: async () => ({ userTags: [], entitlements: ['lake:gate'] }) },
}));

import { assertCanRunUsersBulkAction, tagsAddedBy } from './authorize';

const reqFor = (isAdmin: boolean) => ({ user: { id: 'adm', isAdmin }, ability: { can: () => true } }) as never;

describe('assertCanRunUsersBulkAction managed tags', () => {
  beforeEach(() => {
    mockRequire.mockReset();
  });

  it('refuses a managed tag from a delegated admin', async () => {
    await expect(assertCanRunUsersBulkAction(reqFor(false), 'addTag', { tags: ['Developer'] })).rejects.toThrow(
      ForbiddenError
    );
  });

  it('refuses a managed tag written as an alias from a delegated admin', async () => {
    await expect(assertCanRunUsersBulkAction(reqFor(false), 'addTag', { tags: ['developer'] })).rejects.toThrow(
      ForbiddenError
    );
  });

  it('allows an ordinary tag for a delegated admin', async () => {
    await expect(
      assertCanRunUsersBulkAction(reqFor(false), 'addTag', { tags: ['beta-cohort'] })
    ).resolves.toBeUndefined();
  });

  it('allows a managed tag for a full admin', async () => {
    await expect(assertCanRunUsersBulkAction(reqFor(true), 'addTag', { tags: ['Developer'] })).resolves.toBeUndefined();
  });

  it('refuses a lake gate tag from a delegated admin and allows it for a full admin', async () => {
    await expect(assertCanRunUsersBulkAction(reqFor(false), 'addTag', { tags: ['Lake:Gate'] })).rejects.toThrow(
      'data lake access'
    );
    await expect(assertCanRunUsersBulkAction(reqFor(true), 'addTag', { tags: ['Lake:Gate'] })).resolves.toBeUndefined();
  });
});

describe('tagsAddedBy', () => {
  it('returns the tag for addTag', () => {
    expect(tagsAddedBy({ type: 'addTag', tag: 'Developer' })).toEqual(['Developer']);
  });

  it('returns nothing for other action types', () => {
    expect(tagsAddedBy({ type: 'suspend' })).toEqual([]);
  });
});
