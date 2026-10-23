import { describe, expect, it } from 'vitest';
import {
  AWAITING_OUTPUT_MAX_POLL_AGE_MS,
  SOCKET_DOWN_POLL_MS,
  LIST_URL_REFRESH_LEAD_MS,
  URL_REFRESH_FLOOR_MS,
  generationListRefreshInterval,
  generationJobPollInterval,
} from './generationJobPolling';

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

describe('terminal generation settlement polling', () => {
  it.each(['succeeded', 'failed', 'cancelled', 'blocked'] as const)(
    'waits for %s settlement even with a live socket',
    state => {
      const job = {
        state,
        updated_at: new Date(NOW).toISOString(),
        output: null,
        credits: { reserved: 10, settled: null },
      };
      expect(generationJobPollInterval(job, true, NOW)).toBe(SOCKET_DOWN_POLL_MS);
      expect(generationJobPollInterval(job, false, NOW)).toBe(SOCKET_DOWN_POLL_MS);
      expect(generationJobPollInterval(job, true, NOW + AWAITING_OUTPUT_MAX_POLL_AGE_MS)).toBe(false);
    }
  );

  it('stops failed-job polling after a zero-credit refund settles, or when no hold exists', () => {
    const job = { state: 'failed' as const, updated_at: new Date(NOW).toISOString(), output: null };
    expect(generationJobPollInterval({ ...job, credits: { reserved: 10, settled: 0 } }, true, NOW)).toBe(false);
    expect(generationJobPollInterval({ ...job, credits: { reserved: null, settled: null } }, true, NOW)).toBe(false);
  });
});

it('preserves URL refresh and scan backoff after the unsettled-balance polling window ends', () => {
  const job = {
    state: 'succeeded' as const,
    updated_at: new Date(NOW - AWAITING_OUTPUT_MAX_POLL_AGE_MS).toISOString(),
    credits: { reserved: 10, settled: null },
  };
  const ready = { availability: 'ready' as const, expires_at: new Date(NOW + 15 * MINUTE).toISOString() };
  expect(generationJobPollInterval({ ...job, output: ready }, true, NOW)).toBe(14 * MINUTE);
  const scanning = { availability: 'pending_scan' as const, expires_at: null };
  expect(generationJobPollInterval({ ...job, output: scanning }, true, NOW)).toBe(5 * MINUTE);
});
