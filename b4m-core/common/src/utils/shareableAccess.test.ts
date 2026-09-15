import { describe, it, expect } from 'vitest';
import { Permission } from '../types/entities/ShareableDocumentTypes';
import { canUpdateShareable } from './shareableAccess';

describe('canUpdateShareable', () => {
  const doc = (users: Array<{ userId: string; permissions: Permission[] }>, groups = []) => ({
    userId: 'owner',
    users,
    groups,
  });

  it('grants the owner', () => {
    expect(canUpdateShareable(doc([]), 'owner')).toBe(true);
  });

  it('denies a read-only sharee', () => {
    expect(canUpdateShareable(doc([{ userId: 'bob', permissions: [Permission.read] }]), 'bob')).toBe(false);
  });

  it('denies a share-only sharee, matching findUpdateAccessById', () => {
    expect(canUpdateShareable(doc([{ userId: 'bob', permissions: [Permission.share] }]), 'bob')).toBe(false);
  });

  it('grants a sharee holding update', () => {
    expect(canUpdateShareable(doc([{ userId: 'bob', permissions: [Permission.read, Permission.update] }]), 'bob')).toBe(
      true
    );
  });

  it('grants via a group update grant only when the caller is in that group', () => {
    const shared = { userId: 'owner', users: [], groups: [{ groupId: 'grp-1', permissions: [Permission.update] }] };
    expect(canUpdateShareable(shared, 'bob', ['grp-1'])).toBe(true);
    expect(canUpdateShareable(shared, 'bob', ['grp-2'])).toBe(false);
    expect(canUpdateShareable(shared, 'bob')).toBe(false);
  });

  it('denies an absent document or caller', () => {
    expect(canUpdateShareable(null, 'bob')).toBe(false);
    expect(canUpdateShareable(doc([]), undefined)).toBe(false);
  });
});
