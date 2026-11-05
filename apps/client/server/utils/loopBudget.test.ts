import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: async (key: string) => settings[key] },
}));
vi.mock('@bike4mind/llm-adapters', () => ({}));
vi.mock('@bike4mind/services', () => ({}));

const { laneCreditCap, loopLaneLimits } = await import('./loopBudget');

describe('laneCreditCap', () => {
  it('splits the admitted cap evenly across the lanes left', () => {
    expect(laneCreditCap(9, 3, 0.5)).toBe(3);
    expect(laneCreditCap(9, 1, 0.5)).toBe(9);
    expect(laneCreditCap(9, 0, 0.5)).toBe(9);
  });

  it('refuses a share under one iteration, and passes no cap through', () => {
    expect(laneCreditCap(1, 3, 0.5)).toBe('too_small');
    expect(laneCreditCap(undefined, 3, 0.5)).toBeUndefined();
  });
});

describe('loopLaneLimits', () => {
  beforeEach(() => {
    for (const key of Object.keys(settings)) delete settings[key];
  });

  it('defaults to 4 server-wide and 2 per user', async () => {
    expect(await loopLaneLimits()).toEqual({ maxActiveRuns: 4, lanesPerUser: 2 });
  });

  it('clamps stored values to the executor slots and to one chat slot free', async () => {
    Object.assign(settings, { LoopsMaxActiveRuns: 50, LoopsCloudLanesPerUser: 9 });
    expect(await loopLaneLimits()).toEqual({ maxActiveRuns: 10, lanesPerUser: 2 });
    Object.assign(settings, { LoopsMaxActiveRuns: 0, LoopsCloudLanesPerUser: 1.7 });
    expect(await loopLaneLimits()).toEqual({ maxActiveRuns: 1, lanesPerUser: 1 });
  });
});
