import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { resolveSignupGrantSchedule, userReadableSettingKeys } from '@bike4mind/common';
const h = vi.hoisted(() => ({ rows: [] as { settingName: string; settingValue: unknown }[] }));
vi.mock('./data/settings', () => ({ useSettingsFromServer: () => ({ data: h.rows }) }));
import { useSignupGrantSchedule } from './useSignupGrantSchedule';

type Row = { settingName: string; settingValue: unknown };
const rowsOf = (values: Record<string, unknown>): Row[] =>
  Object.entries(values).map(([settingName, settingValue]) => ({ settingName, settingValue }));

async function serverSchedule(rows: Row[]) {
  const requested: string[] = [];
  const schedule = await resolveSignupGrantSchedule({
    findBySettingName: async () => null,
    findBySettingNames: async (names: string[]) => {
      requested.push(...names);
      return rows.filter(row => names.includes(row.settingName)) as never;
    },
  });
  return { schedule, requested };
}

describe('useSignupGrantSchedule parity with the server resolver', () => {
  it('reads only settings a non-admin caller can fetch', async () => {
    const { requested } = await serverSchedule([]);
    const readable = new Set<string>(userReadableSettingKeys());
    expect(requested.filter(key => !readable.has(key))).toEqual([]);
  });

  it.each([
    ['no rows', {}],
    [
      'schedule keys set',
      {
        signupGrantInitialCredits: '0',
        signupGrantDailyCredits: 40,
        signupGrantDripCap: '6000',
        signupGrantInviteBonusCredits: 10,
      },
    ],
    ['invalid stored values', { signupGrantDripCap: '', signupGrantDailyCredits: -1, signupGrantInitialCredits: 1.5 }],
  ])('resolves the same schedule as the server for %s', async (_label, values) => {
    h.rows = rowsOf(values);
    const { schedule } = await serverSchedule(h.rows);
    expect(renderHook(useSignupGrantSchedule).result.current).toEqual(schedule);
  });
});
