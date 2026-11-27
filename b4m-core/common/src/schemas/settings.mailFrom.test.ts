import { describe, it, expect } from 'vitest';
import { API_SERVICE_GROUPS, SettingKeySchema, settingsMap } from './settings';

describe('mailFrom setting', () => {
  it('is an Admin string setting in the Server Administration group, empty by default', () => {
    expect(SettingKeySchema.safeParse('mailFrom').success).toBe(true);
    expect(settingsMap.mailFrom).toMatchObject({ type: 'string', category: 'Admin', defaultValue: '' });
    expect(settingsMap.mailFrom.group).toBe(API_SERVICE_GROUPS.ADMIN.id);
    expect(API_SERVICE_GROUPS.ADMIN.settings.map(s => s.key)).toContain('mailFrom');
  });

  it.each(['', '  ', 'noreply@example.com', 'Example <noreply@example.com>'])('accepts %j', value => {
    expect(settingsMap.mailFrom.schema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['a line break', 'noreply@example.com\r\nBcc: x@example.com'],
    ['a bare line feed', 'noreply@example.com\nX: y'],
    ['an overlong value', `${'a'.repeat(320)}@example.com`],
    ['a non-string', 42],
  ])('rejects %s', (_label, value) => {
    expect(settingsMap.mailFrom.schema.safeParse(value).success).toBe(false);
  });
});
