import { describe, expect, it } from 'vitest';
import { roleForPermissions } from './organizationInviteRoles';
import { Permission } from './ShareableDocumentTypes';

describe('roleForPermissions', () => {
  it.each([
    [[Permission.read], 'viewer'],
    [[Permission.update, Permission.read], 'editor'],
    [[Permission.share, Permission.read, Permission.update], 'admin'],
    [[Permission.read, Permission.read], 'viewer'],
  ])('maps %j to %s', (permissions, role) => {
    expect(roleForPermissions(permissions)).toBe(role);
  });

  it.each([[[]], [[Permission.share]], [[Permission.update]], [[Permission.read, Permission.delete]]])(
    'returns null for %j',
    permissions => {
      expect(roleForPermissions(permissions)).toBeNull();
    }
  );
});
