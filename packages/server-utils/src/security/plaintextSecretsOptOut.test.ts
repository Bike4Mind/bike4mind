import { describe, it, expect, vi } from 'vitest';
import { isPlaintextSecretsOptOutActive, warnIfPlaintextSecretsOptOut } from './plaintextSecretsOptOut';

const KEY = 'a'.repeat(64);

describe('plaintext secrets opt-out', () => {
  it('is active only with the opt-out set to exactly true and no valid key', () => {
    expect(isPlaintextSecretsOptOutActive({ B4M_ALLOW_PLAINTEXT_SECRETS: 'true' })).toBe(true);
    expect(
      isPlaintextSecretsOptOutActive({ B4M_ALLOW_PLAINTEXT_SECRETS: 'true', SECRET_ENCRYPTION_KEY: 'change-me' })
    ).toBe(true);
  });

  it('is inactive with a valid key or without the opt-out', () => {
    expect(isPlaintextSecretsOptOutActive({ B4M_ALLOW_PLAINTEXT_SECRETS: 'true', SECRET_ENCRYPTION_KEY: KEY })).toBe(
      false
    );
    expect(isPlaintextSecretsOptOutActive({})).toBe(false);
    expect(isPlaintextSecretsOptOutActive({ B4M_ALLOW_PLAINTEXT_SECRETS: '1' })).toBe(false);
    expect(isPlaintextSecretsOptOutActive({ B4M_ALLOW_PLAINTEXT_SECRETS: 'TRUE' })).toBe(false);
  });

  it('warns once when active and stays silent otherwise', () => {
    const logger = { warn: vi.fn() };
    warnIfPlaintextSecretsOptOut(logger, { B4M_ALLOW_PLAINTEXT_SECRETS: 'true' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('PLAINTEXT');
    warnIfPlaintextSecretsOptOut(logger, { B4M_ALLOW_PLAINTEXT_SECRETS: 'true', SECRET_ENCRYPTION_KEY: KEY });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
