import { describe, expect, it } from 'vitest';
import { musicJob, musicOutput } from './__test__/musicGenerationFixtures';
import { AWAITING_OUTPUT_MAX_POLL_AGE_MS, PENDING_SCAN_POLL_MS, SOCKET_DOWN_POLL_MS } from './generationJobPolling';
import { musicGenerationPollInterval } from './musicGenerations';

const NOW = Date.parse('2026-10-07T00:00:10.000Z');

describe('musicGenerationPollInterval', () => {
  it('does not poll without data', () => {
    expect(musicGenerationPollInterval(undefined, true, NOW)).toBe(false);
  });

  it('polls a live job only while the socket is down', () => {
    expect(musicGenerationPollInterval(musicJob({ state: 'running' }), false, NOW)).toBe(SOCKET_DOWN_POLL_MS);
    expect(musicGenerationPollInterval(musicJob({ state: 'running' }), true, NOW)).toBe(false);
  });

  it('keeps polling a succeeded job with no output yet, then gives up', () => {
    const job = musicJob({ state: 'succeeded', output: null });
    expect(musicGenerationPollInterval(job, true, NOW)).toBe(SOCKET_DOWN_POLL_MS);
    expect(musicGenerationPollInterval(job, true, NOW + AWAITING_OUTPUT_MAX_POLL_AGE_MS)).toBe(false);
  });

  it('polls a scanning song and stops for an unavailable or failed one', () => {
    const scanning = musicJob({
      state: 'succeeded',
      output: musicOutput({ availability: 'pending_scan', url: null, expires_at: null }),
    });
    expect(musicGenerationPollInterval(scanning, true, NOW)).toBe(PENDING_SCAN_POLL_MS);
    const gone = musicJob({
      state: 'succeeded',
      output: musicOutput({ availability: 'unavailable', url: null, expires_at: null }),
    });
    expect(musicGenerationPollInterval(gone, true, NOW)).toBe(false);
    expect(musicGenerationPollInterval(musicJob({ state: 'failed' }), true, NOW)).toBe(false);
  });

  it('schedules a re-sign for a ready song', () => {
    const ready = musicJob({ state: 'succeeded', output: musicOutput() });
    expect(musicGenerationPollInterval(ready, true, NOW)).toBeGreaterThan(0);
  });
});
