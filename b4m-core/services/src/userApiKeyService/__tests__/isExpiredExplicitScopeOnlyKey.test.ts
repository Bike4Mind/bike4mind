import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import type { IUserApiKeyDocument } from '@bike4mind/common';
import { isExpiredExplicitScopeOnlyKey } from '../validate';
import { KEY_PREFIX_LENGTH } from '../constants';

const KEY = `b4m_live_${'a'.repeat(48)}`;
const digest = (key: string) => createHash('sha256').update(key).digest('hex');
const stored = {
  id: 'k1',
  keyPrefix: KEY.substring(0, KEY_PREFIX_LENGTH),
  keyDigest: digest(KEY),
} as IUserApiKeyDocument;

const adapters = (rows: IUserApiKeyDocument[]) => ({
  db: { userApiKeys: { findExpiredExplicitScopeOnlyByKeyPrefix: vi.fn().mockResolvedValue(rows) } },
});

describe('isExpiredExplicitScopeOnlyKey', () => {
  it('is true when the presented secret matches an expired MCP key', async () => {
    await expect(isExpiredExplicitScopeOnlyKey(KEY, adapters([stored]))).resolves.toBe(true);
  });

  it('is false for a wrong secret under the same prefix, so a guessed prefix learns nothing', async () => {
    const wrong = `${KEY.slice(0, -1)}b`;
    await expect(isExpiredExplicitScopeOnlyKey(wrong, adapters([stored]))).resolves.toBe(false);
  });

  it('is false when nothing expired matches, and never queries for a non-key string', async () => {
    await expect(isExpiredExplicitScopeOnlyKey(KEY, adapters([]))).resolves.toBe(false);
    const a = adapters([stored]);
    await expect(isExpiredExplicitScopeOnlyKey('nope', a)).resolves.toBe(false);
    expect(a.db.userApiKeys.findExpiredExplicitScopeOnlyByKeyPrefix).not.toHaveBeenCalled();
  });
});
