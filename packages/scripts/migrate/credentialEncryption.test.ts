import { describe, expect, it, vi } from 'vitest';
import { encryptSecret, decryptSecret, generateEncryptionKey } from '@bike4mind/utils/security';
import { encryptIfNeeded, reencryptValue } from './encrypt-tokens-at-rest';
import { transformIfNeeded } from './encrypt-admin-settings-and-apikeys';

const current = generateEncryptionKey();
const previous = generateEncryptionKey();
const mcpContext = JSON.stringify(['mcp', 'owner', 'record', 'API_KEY']);
const apiContext = JSON.stringify(['ApiKey', 'owner', 'record', 'apiKey']);

describe('operator encryption commands', () => {
  it('encrypts plaintext with its context and leaves stored ciphertext alone on reruns', () => {
    const encrypted = encryptIfNeeded('credential-canary', current, undefined, mcpContext)!;
    expect(decryptSecret(encrypted, current, mcpContext)).toBe('credential-canary');
    expect(encryptIfNeeded(encrypted, current, undefined, mcpContext)).toBeNull();
  });
  it.each([false, true])('rotates legacy and bound MCP values safely (bound: %s)', bound => {
    const old = encryptSecret('credential-canary', previous, bound ? mcpContext : undefined);
    const rotated = reencryptValue(old, current, previous, mcpContext)!;
    expect(decryptSecret(rotated, current, mcpContext)).toBe('credential-canary');
    expect(reencryptValue(rotated, current, previous, mcpContext)).toBeNull();
  });
  it('supports both API-key rotation and explicit plaintext rollback without dropping ownership', () => {
    const old = encryptSecret('credential-canary', previous, apiContext);
    const rotated = transformIfNeeded(old, current, previous, apiContext, 'reencrypt')!;
    expect(decryptSecret(rotated, current, apiContext)).toBe('credential-canary');
    expect(transformIfNeeded(rotated, current, previous, apiContext, 'reencrypt')).toBeNull();
    expect(transformIfNeeded(rotated, current, previous, apiContext, 'decrypt')).toBe('credential-canary');
  });
  it('fails closed when an owning context is wrong', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const old = encryptSecret('credential-canary', previous, apiContext);
      expect(transformIfNeeded(old, current, previous, 'another-context', 'reencrypt')).toBe('error');
      expect(JSON.stringify(spy.mock.calls)).not.toContain('credential-canary');
    } finally {
      spy.mockRestore();
    }
  });
});
