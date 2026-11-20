import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import { ApiKeyStatus } from '@bike4mind/common';
import type { IUserApiKeyDocument } from '@bike4mind/common';
import { findOwnerOfDisabledUserApiKey } from '../validate';
import { KEY_PREFIX_LENGTH, LEGACY_KEY_PREFIX_LENGTH } from '../constants';

const KEY = `b4m_live_${'a'.repeat(48)}`;
const digest = (key: string) => createHash('sha256').update(key).digest('hex');

function disabledKey(overrides: Partial<IUserApiKeyDocument> = {}): IUserApiKeyDocument {
  return {
    id: 'key-1',
    userId: 'owner-1',
    keyPrefix: KEY.substring(0, KEY_PREFIX_LENGTH),
    keyDigest: digest(KEY),
    status: ApiKeyStatus.DISABLED,
    ...overrides,
  } as IUserApiKeyDocument;
}

const adaptersFor = (byPrefix: Record<string, IUserApiKeyDocument[]>) => ({
  db: {
    userApiKeys: {
      findDisabledByKeyPrefix: vi.fn((prefix: string) => Promise.resolve(byPrefix[prefix] ?? [])),
    },
  },
});

describe('findOwnerOfDisabledUserApiKey', () => {
  it('returns the owner of a disabled key whose secret matches', async () => {
    const adapters = adaptersFor({ [KEY.substring(0, KEY_PREFIX_LENGTH)]: [disabledKey()] });

    await expect(findOwnerOfDisabledUserApiKey(KEY, adapters)).resolves.toBe('owner-1');
  });

  it('returns null when only the prefix matches, so a guessed prefix reveals no owner', async () => {
    const adapters = adaptersFor({
      [KEY.substring(0, KEY_PREFIX_LENGTH)]: [disabledKey({ keyDigest: digest(`${KEY}x`) })],
    });

    await expect(findOwnerOfDisabledUserApiKey(KEY, adapters)).resolves.toBeNull();
  });

  it('falls back to the legacy prefix length', async () => {
    const legacyPrefix = KEY.substring(0, LEGACY_KEY_PREFIX_LENGTH);
    const adapters = adaptersFor({ [legacyPrefix]: [disabledKey({ keyPrefix: legacyPrefix })] });

    await expect(findOwnerOfDisabledUserApiKey(KEY, adapters)).resolves.toBe('owner-1');
  });

  it('returns null for a non-live key or a repository without the lookup', async () => {
    const adapters = adaptersFor({ [KEY.substring(0, KEY_PREFIX_LENGTH)]: [disabledKey()] });

    await expect(findOwnerOfDisabledUserApiKey('sk-not-ours', adapters)).resolves.toBeNull();
    await expect(findOwnerOfDisabledUserApiKey(KEY, { db: { userApiKeys: {} } })).resolves.toBeNull();
    expect(adapters.db.userApiKeys.findDisabledByKeyPrefix).not.toHaveBeenCalled();
  });
});
