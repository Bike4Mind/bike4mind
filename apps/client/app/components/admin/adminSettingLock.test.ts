import { describe, it, expect } from 'vitest';
import { FULL_ADMIN_ONLY_SETTING_NOTE, fullAdminOnlySettingNote } from './adminSettingLock';

const delegate = { isAdmin: false, adminPermissions: ['settings:manage'] };

describe('fullAdminOnlySettingNote', () => {
  it('locks a full-admin-only key for a delegate', () => {
    expect(fullAdminOnlySettingNote(delegate, 'enforceMFA')).toBe(FULL_ADMIN_ONLY_SETTING_NOTE);
  });

  it('leaves other keys editable for a delegate', () => {
    expect(fullAdminOnlySettingNote(delegate, 'DefaultAPIModel')).toBeUndefined();
  });

  it('leaves every key editable for a full admin', () => {
    expect(fullAdminOnlySettingNote({ isAdmin: true }, 'enforceMFA')).toBeUndefined();
  });
});
