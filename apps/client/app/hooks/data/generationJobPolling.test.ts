import { describe, expect, it } from 'vitest';
import { LIST_URL_REFRESH_LEAD_MS, URL_REFRESH_FLOOR_MS, generationListRefreshInterval } from './generationJobPolling';

const NOW = Date.parse('2026-10-07T00:00:00.000Z');
const MINUTE = 60_000;

const readyJob = (expiresInMs: number | null) => ({
  output: {
    availability: 'ready' as const,
    expires_at: expiresInMs === null ? null : new Date(NOW + expiresInMs).toISOString(),
  },
});

describe('generationListRefreshInterval', () => {
  it('returns false when nothing on the list expires', () => {
    expect(generationListRefreshInterval(undefined, NOW)).toBe(false);
    expect(generationListRefreshInterval({ pages: [{ data: [readyJob(null), { output: null }] }] }, NOW)).toBe(false);
    expect(
      generationListRefreshInterval(
        {
          pages: [
            {
              data: [{ output: { availability: 'pending_scan', expires_at: readyJob(10 * MINUTE).output.expires_at } }],
            },
          ],
        },
        NOW
      )
    ).toBe(false);
  });

  it('refreshes ahead of the earliest expiry across every page', () => {
    const list = {
      pages: [{ data: [readyJob(14 * MINUTE)] }, { data: [readyJob(9 * MINUTE), readyJob(12 * MINUTE)] }],
    };
    expect(generationListRefreshInterval(list, NOW)).toBe(9 * MINUTE - LIST_URL_REFRESH_LEAD_MS);
  });

  it('clamps an already-expired url to the refresh floor', () => {
    expect(generationListRefreshInterval({ pages: [{ data: [readyJob(-5 * MINUTE)] }] }, NOW)).toBe(
      URL_REFRESH_FLOOR_MS
    );
  });
});
