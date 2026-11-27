import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@bike4mind/common';

const mockRequire = vi.fn();

vi.mock('@server/middlewares/adminApi', () => ({ requireAdminPermission: (...a: unknown[]) => mockRequire(...a) }));

import { assertCanRunUsersBulkAction, tagsAddedBy } from './authorize';

const reqFor = (isAdmin: boolean) => ({ user: { id: 'adm', isAdmin }, ability: { can: () => true } }) as never;

describe('assertCanRunUsersBulkAction managed tags', () => {
  beforeEach(() => {
    mockRequire.mockReset();
  });

  it('refuses a managed tag from a delegated admin', () => {
    expect(() => assertCanRunUsersBulkAction(reqFor(false), 'addTag', { tags: ['Developer'] })).toThrow(ForbiddenError);
  });

  it('refuses a managed tag written as an alias from a delegated admin', () => {
    expect(() => assertCanRunUsersBulkAction(reqFor(false), 'addTag', { tags: ['developer'] })).toThrow(ForbiddenError);
  });

  it('allows an ordinary tag for a delegated admin', () => {
    expect(() => assertCanRunUsersBulkAction(reqFor(false), 'addTag', { tags: ['beta-cohort'] })).not.toThrow();
  });

  it('allows a managed tag for a full admin', () => {
    expect(() => assertCanRunUsersBulkAction(reqFor(true), 'addTag', { tags: ['Developer'] })).not.toThrow();
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
