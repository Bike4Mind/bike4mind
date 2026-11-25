import { describe, expect, it } from 'vitest';
import { permissionProtectedCipher } from './permissionProtectedCipher';

describe('permissionProtectedCipher', () => {
  it('does not claim to encrypt, and declares file-permission protection instead', () => {
    expect(permissionProtectedCipher.isEncryptionAvailable()).toBe(false);
    expect(permissionProtectedCipher.atRestProtection).toBe('file-permissions');
  });

  it('round-trips text, including non-ASCII', () => {
    const text = '{"refreshToken":"réfresh"}';
    expect(permissionProtectedCipher.decryptString(permissionProtectedCipher.encryptString(text))).toBe(text);
  });
});
