import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ findOne: vi.fn(), updateOne: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ AdminSettings: h }));
import migration from './20260921235967_seed-staged-signup-settings';

describe('staged signup setting migration', () => {
  it('has a distinct migration id so the inbox-claim backfill cannot suppress the seed', () => {
    const migrationFiles = readdirSync(dirname(fileURLToPath(import.meta.url))).filter(
      file => /^\d+_.+\.ts$/.test(file) && !file.includes('.test.') && !file.includes('.integration.')
    );
    const matchingFiles = migrationFiles.filter(file => Number(file.slice(0, file.indexOf('_'))) === migration.id);
    expect(matchingFiles).toEqual([`${migration.id}_seed-staged-signup-settings.ts`]);
  });

  beforeEach(() => {
    h.findOne.mockReset();
    h.updateOne.mockReset();
  });
  it.each(['0', '37', '-2', undefined])('preserves the legacy grant %s and enables no new grants', async value => {
    h.findOne.mockResolvedValue(value === undefined ? null : { settingValue: value });
    await migration.up();
    expect(h.updateOne).toHaveBeenCalledWith(
      { settingName: 'signupGrantCredits' },
      {
        $setOnInsert: { settingName: 'signupGrantCredits', settingValue: value === '37' ? '37' : '0' },
      },
      { upsert: true }
    );
    expect(h.updateOne).toHaveBeenCalledWith(
      { settingName: 'verifiedUnlockCredits' },
      {
        $setOnInsert: { settingName: 'verifiedUnlockCredits', settingValue: '0' },
      },
      { upsert: true }
    );
    expect(h.updateOne).toHaveBeenCalledWith(
      { settingName: 'stagedSignupGrantEnabled' },
      {
        $setOnInsert: { settingName: 'stagedSignupGrantEnabled', settingValue: 'false' },
      },
      { upsert: true }
    );
  });
  it('seeds organization invitation unlocks disabled and preserves operator values across reruns', async () => {
    const stored = new Map<string, string>([['defaultFreeCredits', '37']]);
    h.findOne.mockImplementation(async ({ settingName }: { settingName: string }) =>
      stored.has(settingName) ? { settingValue: stored.get(settingName) } : null
    );
    h.updateOne.mockImplementation(
      async ({ settingName }: { settingName: string }, update: { $setOnInsert: { settingValue: string } }) => {
        if (!stored.has(settingName)) stored.set(settingName, update.$setOnInsert.settingValue);
      }
    );
    await migration.up();
    expect(stored.get('signupGrantOrgInviteEnabled')).toBe('false');
    stored.set('signupGrantOrgInviteEnabled', 'true');
    stored.set('signupGrantCredits', '23');
    await migration.up();
    await migration.down();
    expect(stored.get('signupGrantOrgInviteEnabled')).toBe('true');
    expect(stored.get('signupGrantCredits')).toBe('23');
  });
  it('never overwrites operator configuration on rerun or rollback', async () => {
    h.findOne.mockResolvedValue({ settingValue: '37' });
    await migration.up();
    await migration.down();
    expect(h.updateOne).toHaveBeenCalledTimes(8);
    for (const [, update] of h.updateOne.mock.calls) expect(Object.keys(update)).toEqual(['$setOnInsert']);
  });
});
