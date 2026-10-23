import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ receiveFromQueue: vi.fn(), deleteFromQueue: vi.fn() }));
import { SelfHostWorker } from './selfHostWorker';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// US DST transitions in 2026-27: fall back 2026-11-01 06:00Z, spring forward 2027-03-14 07:00Z.
const DST_TZ = 'America/New_York';

// Pins the zone at runtime, overriding the process TZ, so every leg that runs this file exercises it.
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = DST_TZ;
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

function recordRuns() {
  const firedAt: string[] = [];
  const run = vi.fn(async () => {
    firedAt.push(new Date().toISOString());
  });
  return { run, firedAt };
}

describe('daily UTC worker task under a non-UTC process timezone', () => {
  let worker: SelfHostWorker;
  beforeEach(() => {
    vi.useFakeTimers();
    worker = new SelfHostWorker(logger);
  });
  afterEach(async () => {
    await worker.stop();
    vi.useRealTimers();
  });

  it('runs the zone it claims to, so the cases below are not vacuous', () => {
    expect(new Date('2026-10-31T12:00:00Z').getTimezoneOffset()).toBe(240);
    expect(new Date('2026-11-02T12:00:00Z').getTimezoneOffset()).toBe(300);
  });

  // 03 UTC is still the previous local evening in New York (22:00/23:00), so a scheduler that read
  // local calendar fields instead of UTC ones would compute a slot in the past.
  it('stays on 03 UTC across the fall-back transition', async () => {
    vi.setSystemTime(new Date('2026-10-31T02:59:30Z'));
    const { run, firedAt } = recordRuns();
    worker.registerDailyUtcTask('batch', 3, run);
    worker.start();
    await vi.advanceTimersByTimeAsync(30_000 + 2 * DAY_MS);
    expect(firedAt).toEqual(['2026-10-31T03:00:00.000Z', '2026-11-01T03:00:00.000Z', '2026-11-02T03:00:00.000Z']);
  });

  it('stays on 03 UTC across the spring-forward transition', async () => {
    vi.setSystemTime(new Date('2027-03-13T02:59:30Z'));
    const { run, firedAt } = recordRuns();
    worker.registerDailyUtcTask('batch', 3, run);
    worker.start();
    await vi.advanceTimersByTimeAsync(30_000 + 2 * DAY_MS);
    expect(firedAt).toEqual(['2027-03-13T03:00:00.000Z', '2027-03-14T03:00:00.000Z', '2027-03-15T03:00:00.000Z']);
  });

  it('re-anchors to the UTC slot when restarted across a transition', async () => {
    vi.setSystemTime(new Date('2026-10-31T02:59:30Z'));
    const { run, firedAt } = recordRuns();
    worker.registerDailyUtcTask('batch', 3, run);
    worker.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await worker.stop();
    // Down over the transition; back up the next evening, local time.
    vi.setSystemTime(new Date('2026-11-01T22:00:00Z'));
    worker.start();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(firedAt).toEqual(['2026-10-31T03:00:00.000Z', '2026-11-02T03:00:00.000Z']);
  });
});

describe('interval worker task across a restart', () => {
  let worker: SelfHostWorker;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T05:30:00Z'));
    worker = new SelfHostWorker(logger);
  });
  afterEach(async () => {
    await worker.stop();
    vi.useRealTimers();
  });

  // Interval tasks have no wall-clock slot: a restart starts a fresh cadence from that moment.
  it('re-anchors its cadence to the restart, not to the first start', async () => {
    const { run, firedAt } = recordRuns();
    worker.registerScheduledTask('sweep', HOUR_MS, run);
    worker.start();
    await vi.advanceTimersByTimeAsync(HOUR_MS + 20 * 60 * 1000);
    expect(firedAt).toEqual(['2026-11-01T06:30:00.000Z']);
    await worker.stop();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(1);
    worker.start();
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(firedAt).toEqual(['2026-11-01T06:30:00.000Z', '2026-11-01T08:00:00.000Z', '2026-11-01T09:00:00.000Z']);
  });

  it('does not double its cadence after repeated restarts', async () => {
    const { run } = recordRuns();
    worker.registerScheduledTask('sweep', HOUR_MS, run, { runOnStartup: true });
    for (let restart = 0; restart < 3; restart++) {
      worker.start();
      await worker.stop();
      // Let the startup run settle, or the next start's run is skipped as an overlap.
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(run).toHaveBeenCalledTimes(3);
    worker.start();
    expect(run).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    expect(run).toHaveBeenCalledTimes(7);
  });
});
