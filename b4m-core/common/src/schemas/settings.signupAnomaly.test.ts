import { describe, expect, it } from 'vitest';
import { settingsMap } from './settings';

describe('signup anomaly settings', () => {
  const entry = settingsMap.signupAnomaly;
  it('validates a deployment-configurable baseline and threshold', () => {
    expect(entry.schema.parse(entry.defaultValue)).toEqual(entry.defaultValue);
    expect(entry.schema.parse({ ...entry.defaultValue, signupBaseline: 25, thresholdMultiplier: 3 })).toMatchObject({
      signupBaseline: 25,
      thresholdMultiplier: 3,
    });
  });
  it.each([
    { signupBaseline: -1 },
    { minimumCount: 0 },
    { thresholdMultiplier: 0 },
    { apiKeyBaseline: 1.5 },
    { typo: 2 },
  ])('rejects invalid configuration %j', patch => {
    expect(entry.schema.safeParse({ ...entry.defaultValue, ...patch }).success).toBe(false);
  });
});
