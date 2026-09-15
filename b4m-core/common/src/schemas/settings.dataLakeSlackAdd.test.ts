import { describe, it, expect } from 'vitest';
import { settingsMap } from './settings';

/**
 * Pins the gate that makes the Slack `@datalake add` surface live.
 *
 * The declared default is only half of it. `AdminSettingsRepository.getSettingsValue` returns
 * `schema.safeParse(storedValue).data` and falls back to `defaultValue` ONLY when that parse FAILS -
 * so for a key no org has ever written, the default reaches the handler purely because
 * `makeBooleanSetting` builds the schema with `.prefault(...)`, which makes `safeParse(undefined)`
 * succeed and yield the default.
 *
 * Swap `.prefault` for a plain optional and `safeParse(undefined)` would succeed with `undefined`
 * instead, `runDataLakeSlackCommand`'s `if (!enabled)` would read that as OFF, and the feature would
 * be silently dark in every install that never touched the toggle - with every other suite still
 * green, because they all mock `getSettingsValue`. That is the failure this file exists to catch.
 */
describe('EnableDataLakeSlackAdd - the gate that makes the Slack surface live', () => {
  const entry = settingsMap.EnableDataLakeSlackAdd;

  it('is declared on by default', () => {
    expect(entry.defaultValue).toBe(true);
  });

  it('resolves to the default for a key no org has ever written', () => {
    // Mirrors getSettingsValue exactly: parse the absent stored value, fall back only on failure.
    const parsed = entry.schema.safeParse(undefined);
    const resolved = parsed.success ? parsed.data : entry.defaultValue;

    expect(resolved).toBe(true);
    // The handler's gate is a plain truthiness check, so this is what it actually sees.
    expect(Boolean(resolved)).toBe(true);
  });

  it('still lets an explicit stored value win over the default', () => {
    // The rollback lever: turning the toggle off has to beat an on-by-default schema.
    expect(entry.schema.safeParse(false).data).toBe(false);
    expect(entry.schema.safeParse(true).data).toBe(true);
    // `settingValue` is Mixed and string rows demonstrably reach this schema - that is why
    // `makeBooleanSetting` carries the string preprocess at all, and why the admin toggle branches on
    // `typeof value === 'string'`. A rollback on a legacy row hits THIS shape, not the boolean one.
    expect(entry.schema.safeParse('false').data).toBe(false);
    expect(entry.schema.safeParse('true').data).toBe(true);
  });

  it('keeps the parent gate off by default, which is what bounds the blast radius', () => {
    // `runDataLakeSlackCommand` checks EnableDataLakes FIRST and short-circuits, so the flip is inert
    // on any deployment that has not enabled Data Lakes. Both flags are deployment-global (settings are
    // keyed on `settingName` alone), so this is NOT a per-org opt-in - once Data Lakes is on for a
    // deployment, the flip is live across it.
    expect(settingsMap.EnableDataLakes.defaultValue).toBe(false);
    expect(entry.dependsOn).toBe('EnableDataLakes');
  });
});
