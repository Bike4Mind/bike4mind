import { describe, expect, it } from 'vitest';
import type { SideAppsResponse, SideAppUsersResponse } from '@client/shared/sideApps';
import { sideAppsCsv, sideAppUsersCsv } from './sideAppsCsv';

const refusals = { total: 0, byClass: { policy: 0, app_fault: 0, our_fault: 0 }, byReason: [] };

describe('side apps csv', () => {
  it('writes one row per app and neutralises formula-like names', () => {
    const data = {
      spendWindowDays: 30,
      requestWindowDays: 30,
      apps: [
        {
          clientId: 'app-a',
          name: '=HYPERLINK("x")',
          spend: { credits: 5, payingUsers: 2, byTier: { paid: 1, unpaid: 2, org: 1, unrecorded: 1 }, daily: [] },
          requests: { total: 4, byTier: { paid: 1, unpaid: 1, unrecorded: 2 }, byEndpoint: [] },
          outcomes: { completed: 3, failed: 1, interrupted: 0, failureRate: 0.25 },
          refusals,
        },
      ],
    } as unknown as SideAppsResponse;

    const lines = sideAppsCsv(data).split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines[1]).toContain('"0.25"');
  });

  it('writes one row per user with blanks for missing names and a joined model list', () => {
    const data = {
      clientId: 'app-a',
      spendWindowDays: 30,
      users: [
        {
          userId: 'u1',
          name: null,
          email: null,
          currentTier: 'unknown',
          credits: 7,
          creditsByTier: { paid: 7, unpaid: 0, org: 0, unrecorded: 0 },
          requests: 2,
          requestsByEndpoint: [],
          failedRequests: 1,
          refusals: 0,
          lastUsedAt: null,
          topModels: [
            { model: 'm-a', credits: 5 },
            { model: 'm-b', credits: 2 },
          ],
        },
      ],
    } as unknown as SideAppUsersResponse;

    const row = sideAppUsersCsv(data).split('\r\n')[1];
    expect(row.startsWith('"u1","","","unknown","7"')).toBe(true);
    expect(row).toContain('"m-a (5); m-b (2)"');
  });
});
