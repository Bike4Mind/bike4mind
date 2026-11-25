import { describe, expect, it } from 'vitest';
import { createPermissionProtectedCipher } from './permissionProtectedCipher';

describe('createPermissionProtectedCipher', () => {
  it.each(['darwin', 'linux'] as const)('on %s, does not claim to encrypt and declares file permissions', platform => {
    const cipher = createPermissionProtectedCipher(platform);
    expect(cipher.isEncryptionAvailable()).toBe(false);
    expect(cipher.atRestProtection).toBe('file-permissions');
  });

  it('declares no protection on Windows, where file modes restrict nothing', () => {
    const cipher = createPermissionProtectedCipher('win32');
    expect(cipher.isEncryptionAvailable()).toBe(false);
    expect(cipher.atRestProtection).toBeUndefined();
  });

  it('round-trips text, including non-ASCII', () => {
    const cipher = createPermissionProtectedCipher('linux');
    const text = '{"refreshToken":"r\u00e9fresh"}';
    expect(cipher.decryptString(cipher.encryptString(text))).toBe(text);
  });
});
