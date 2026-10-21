import { describe, it, expect } from 'vitest';
import { settingsMap, userReadableSettingKeys } from './settings';

/**
 * Pins the gates that keep the Studio rebuild dark while its pieces land separately. A flipped
 * default would ship the half-built surface to every deployment that never wrote the key.
 */
const STUDIO_FLAGS = ['EnableStudioCreateV2', 'EnableStudioImage', 'EnableStudioProductions'] as const;

describe.each(STUDIO_FLAGS)('%s - Studio rebuild gate', key => {
  const entry = settingsMap[key];

  it('is declared off by default', () => {
    expect(entry.defaultValue).toBe(false);
  });

  it('resolves to off for a key no deployment has ever written', () => {
    // Mirrors getSettingsValue: parse the absent stored value, fall back to the default only on failure.
    const parsed = entry.schema.safeParse(undefined);
    const resolved = parsed.success ? parsed.data : entry.defaultValue;

    expect(resolved).toBe(false);
  });

  it('lets an explicit stored value turn it on, including a legacy string row', () => {
    expect(entry.schema.safeParse(true).data).toBe(true);
    expect(entry.schema.safeParse('true').data).toBe(true);
  });

  it('is readable by the client so the Studio route can gate on it', () => {
    expect(userReadableSettingKeys()).toContain(key);
  });
});

describe('Studio child gates', () => {
  it.each(['EnableStudioImage', 'EnableStudioProductions'] as const)('%s hangs off EnableStudioCreateV2', key => {
    expect(settingsMap[key].dependsOn).toBe('EnableStudioCreateV2');
  });
});
