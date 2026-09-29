import { describe, it, expect } from 'vitest';
import { settingsMap } from './settings';

/**
 * Pins the gate that keeps the GitHub lake source dark while its pieces land separately. Every
 * GitHub lake route applies requireFeatureEnabled('EnableDataLakeGitHub'), which falls back to this
 * default for a deployment that never wrote the key - so a flipped default ships the half-built
 * surface everywhere at once.
 */
describe('EnableDataLakeGitHub - the gate on every GitHub lake route', () => {
  const entry = settingsMap.EnableDataLakeGitHub;

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

  it('hangs off the Data Lakes parent gate', () => {
    expect(entry.dependsOn).toBe('EnableDataLakes');
  });
});
