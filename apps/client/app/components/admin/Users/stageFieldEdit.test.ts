import { describe, it, expect } from 'vitest';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { stageFieldEdit } from './stageFieldEdit';

const savedUser = (overrides: Partial<AdminUserListItem> = {}) =>
  ({
    id: 'u1',
    name: 'Ada',
    isAdmin: false,
    tags: ['research', 'beta'],
    currentCredits: 100,
    ...overrides,
  }) as AdminUserListItem;

describe('stageFieldEdit', () => {
  it('marks a field that differs from the saved value', () => {
    expect(stageFieldEdit({}, 'name', 'Grace', savedUser())).toEqual({ name: true });
  });

  it('clears the mark when the value is put back by hand', () => {
    const edited = stageFieldEdit({}, 'name', 'Grace', savedUser());
    expect(stageFieldEdit(edited, 'name', 'Ada', savedUser())).toEqual({ name: false });
  });

  it('clears the mark when a tag is added and then removed again', () => {
    const saved = savedUser();
    const added = stageFieldEdit({}, 'tags', ['research', 'beta', 'opti'], saved);
    expect(added).toEqual({ tags: true });
    expect(stageFieldEdit(added, 'tags', ['research', 'beta'], saved)).toEqual({ tags: false });
  });

  it('compares tag lists by content, not identity', () => {
    expect(stageFieldEdit({}, 'tags', ['research', 'beta'], savedUser())).toEqual({ tags: false });
  });

  it('treats null and undefined as the same unset value', () => {
    expect(stageFieldEdit({}, 'emailVerifiedAt', null, savedUser())).toEqual({ emailVerifiedAt: false });
  });

  it('marks a date field that gained a value', () => {
    expect(stageFieldEdit({}, 'emailVerifiedAt', new Date('2026-01-01'), savedUser())).toEqual({
      emailVerifiedAt: true,
    });
  });

  it('compares dates by value rather than by reference', () => {
    const saved = savedUser({ subscribedUntil: new Date('2026-01-01') } as Partial<AdminUserListItem>);
    expect(stageFieldEdit({}, 'subscribedUntil', new Date('2026-01-01'), saved)).toEqual({
      subscribedUntil: false,
    });
  });

  it('leaves the marks on other fields alone', () => {
    const edited = stageFieldEdit({}, 'name', 'Grace', savedUser());
    expect(stageFieldEdit(edited, 'currentCredits', 250, savedUser())).toEqual({
      name: true,
      currentCredits: true,
    });
  });
});
