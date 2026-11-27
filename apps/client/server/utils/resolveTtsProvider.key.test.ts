// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

const { findByUserIdAndType, findBySettingName } = vi.hoisted(() => ({
  findByUserIdAndType: vi.fn(),
  findBySettingName: vi.fn(),
}));

// Only the repositories are stubbed: the real apiKeyService decides user-key-before-admin-key.
vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  apiKeyRepository: { findByUserIdAndType: (...a: unknown[]) => findByUserIdAndType(...a) },
  adminSettingsRepository: { findBySettingName: (...a: unknown[]) => findBySettingName(...a) },
}));

import { ApiKeyType } from '@bike4mind/common';
import { getTtsProviderKey } from './resolveTtsProvider';

describe('getTtsProviderKey', () => {
  it("returns the user's own ElevenLabs key over the workspace one", async () => {
    findByUserIdAndType.mockResolvedValue({ apiKey: 'user-key' });
    findBySettingName.mockResolvedValue({ settingValue: 'workspace-key' });

    await expect(getTtsProviderKey('elevenlabs', 'u1')).resolves.toBe('user-key');
    expect(findByUserIdAndType).toHaveBeenCalledWith('u1', ApiKeyType.elevenlabs);
  });

  it('falls back to the workspace key when the user has none', async () => {
    findByUserIdAndType.mockResolvedValue(null);
    findBySettingName.mockResolvedValue({ settingValue: 'workspace-key' });

    await expect(getTtsProviderKey('elevenlabs', 'u1')).resolves.toBe('workspace-key');
  });
});
