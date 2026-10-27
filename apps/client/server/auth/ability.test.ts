import { describe, it, expect } from 'vitest';
import { ModalModel } from '@bike4mind/database';
import defineAbilitiesFor from './ability';
import type { IUserDocument } from '@bike4mind/common';

const userWith = (fields: Partial<IUserDocument>) => ({ id: 'u1', isAdmin: false, ...fields }) as IUserDocument;

describe('defineAbilitiesFor - modal management', () => {
  it.each([
    ['a full admin', userWith({ isAdmin: true })],
    ['a settings:manage delegate', userWith({ adminPermissions: ['settings:manage'] })],
  ])('lets %s manage modals, matching the Modals admin tab gate', (_label, user) => {
    const ability = defineAbilitiesFor(user);
    for (const action of ['create', 'update', 'delete'] as const) {
      expect(ability.can(action, ModalModel)).toBe(true);
    }
    expect(ability.can('manage', 'Modal')).toBe(true);
  });

  it('keeps modal writes from a delegate without settings:manage', () => {
    const ability = defineAbilitiesFor(userWith({ adminPermissions: ['support:read', 'users:moderate'] }));
    expect(ability.can('read', ModalModel)).toBe(true);
    expect(ability.can('create', ModalModel)).toBe(false);
    expect(ability.can('manage', 'Modal')).toBe(false);
  });
});
