import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveModerationOpenaiKey } from './moderationOpenaiKey';

const PLACEHOLDER = 'sk-your-key-here';

describe('resolveModerationOpenaiKey', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers the shared admin key over the user own key', () => {
    expect(resolveModerationOpenaiKey('user-key', 'shared-key')).toBe('shared-key');
  });

  it('uses the shared admin key when the user key has expired', () => {
    expect(resolveModerationOpenaiKey('expired', 'shared-key')).toBe('shared-key');
  });

  it('uses the user own key when no shared key is configured', () => {
    expect(resolveModerationOpenaiKey('user-key', '')).toBe('user-key');
    expect(resolveModerationOpenaiKey('user-key', undefined)).toBe('user-key');
  });

  it('returns null for an expired user key with no shared key, never the sentinel', () => {
    expect(resolveModerationOpenaiKey('expired', '')).toBeNull();
  });

  it('returns null when there is no key at all', () => {
    expect(resolveModerationOpenaiKey(null, null)).toBeNull();
    expect(resolveModerationOpenaiKey(undefined, '')).toBeNull();
  });

  it('uses the self-host env key ahead of the user key when no admin key is stored', () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    vi.stubEnv('OPENAI_API_KEY', 'env-key');
    expect(resolveModerationOpenaiKey('user-key', '')).toBe('env-key');
    expect(resolveModerationOpenaiKey('expired', '')).toBe('env-key');
  });

  it('ignores OPENAI_API_KEY outside self-host', () => {
    vi.stubEnv('B4M_SELF_HOST', 'false');
    vi.stubEnv('OPENAI_API_KEY', 'env-key');
    expect(resolveModerationOpenaiKey('expired', '')).toBeNull();
  });

  it('ignores a placeholder shared key and falls back to the user key', () => {
    expect(resolveModerationOpenaiKey('user-key', PLACEHOLDER)).toBe('user-key');
  });

  it('ignores a placeholder self-host env key and falls back to the user key', () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    vi.stubEnv('OPENAI_API_KEY', PLACEHOLDER);
    expect(resolveModerationOpenaiKey('user-key', '')).toBe('user-key');
  });

  it('returns null for a placeholder user key with no shared or env key', () => {
    expect(resolveModerationOpenaiKey(PLACEHOLDER, '')).toBeNull();
  });
});
