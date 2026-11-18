import { describe, expect, it } from 'vitest';
import {
  ARM_MIN_ACTIVE_DAYS,
  ARM_MIN_SUCCESSES,
  DAY_MS,
  FAIL_MIN_ATTEMPTS,
  HOUR_MS,
  PLATFORM_RULE,
  PLATFORM_SCOPE,
  REMINDER_INTERVAL_MS,
  SILENCE_FLOOR_HOURS,
  desiredAlerts,
  emptyWindowCounts,
  evaluateClient,
  evaluatePlatform,
  hourStartOf,
  longestClosedGapHours,
  reminderDue,
  topFailureReasons,
  type ClientHealthInput,
  type HourlyBucket,
  type WindowCounts,
} from './rules';

const NOW = Date.UTC(2026, 10, 18, 12, 30);
const hourAgo = (hours: number) => hourStartOf(NOW) - hours * HOUR_MS;
const success = (hoursBack: number, successes = 3): HourlyBucket => ({
  hourStart: hourAgo(hoursBack),
  successes,
  failures: 0,
  ourFaultFailures: 0,
});

/** A steady app: successes every `every` hours for 7 days, so it is armed. */
const steadySeries = (every = 1, skip: (hoursBack: number) => boolean = () => false): HourlyBucket[] => {
  const series: HourlyBucket[] = [];
  for (let back = 7 * 24 - 1; back >= 0; back -= every) {
    if (!skip(back)) series.push(success(back));
  }
  return series;
};

const lastHour = (partial: Partial<WindowCounts> = {}): WindowCounts => ({ ...emptyWindowCounts(), ...partial });
const client = (
  hourly: HourlyBucket[],
  last: WindowCounts = lastHour({ successes: 3 }),
  clientId = 'app'
): ClientHealthInput => ({
  clientId,
  hourly,
  lastHour: last,
});

describe('arming', () => {
  it('arms a client with enough successes on enough days', () => {
    expect(evaluateClient(client(steadySeries()), NOW).armed).toBe(true);
  });

  it('does not arm a client active on too few days, however busy', () => {
    const days = ARM_MIN_ACTIVE_DAYS - 1;
    const hourly = [0, 1].map(day => success(day * 24 + 1, 500));
    expect(hourly).toHaveLength(days);
    expect(evaluateClient(client(hourly), NOW).armed).toBe(false);
  });

  it('does not count a day below the success minimum', () => {
    const hourly = [1, 25, 49].map(back => success(back, ARM_MIN_SUCCESSES - 1));
    expect(evaluateClient(client(hourly), NOW).armed).toBe(false);
    const enough = [1, 25, 49].map(back => success(back, ARM_MIN_SUCCESSES));
    expect(evaluateClient(client(enough), NOW).armed).toBe(true);
  });

  it('never alerts an unarmed client, even when failing and silent', () => {
    const verdict = evaluateClient(client([success(40, 1)], lastHour({ failures: 50, ourFaultFailures: 50 })), NOW);
    expect(verdict).toMatchObject({ armed: false, rule: null });
  });
});

describe('failing rule', () => {
  it('fires on enough attempts with no success', () => {
    const verdict = evaluateClient(
      client(steadySeries(), lastHour({ failures: FAIL_MIN_ATTEMPTS, ourFaultFailures: 0 })),
      NOW
    );
    expect(verdict.rule).toBe('failing');
  });

  it('stays quiet below the attempt minimum', () => {
    const verdict = evaluateClient(client(steadySeries(), lastHour({ failures: FAIL_MIN_ATTEMPTS - 1 })), NOW);
    expect(verdict.rule).toBeNull();
  });

  it('fires when more than half of attempts are our fault, even with some successes', () => {
    const verdict = evaluateClient(
      client(steadySeries(), lastHour({ successes: 4, failures: 6, ourFaultFailures: 6 })),
      NOW
    );
    expect(verdict.rule).toBe('failing');
  });

  it('does not fire when the failures are the app own fault and some requests succeed', () => {
    const verdict = evaluateClient(
      client(steadySeries(), lastHour({ successes: 4, failures: 6, ourFaultFailures: 0 })),
      NOW
    );
    expect(verdict.rule).toBeNull();
  });

  it('needs more than, not exactly, the failure rate', () => {
    const verdict = evaluateClient(
      client(steadySeries(), lastHour({ successes: 5, failures: 5, ourFaultFailures: 5 })),
      NOW
    );
    expect(verdict.rule).toBeNull();
  });

  it('reports the top failure reasons by count', () => {
    const verdict = evaluateClient(
      client(steadySeries(), lastHour({ failures: 9, ourFaultFailures: 9, reasons: { a: 1, b: 5, c: 3, d: 2 } })),
      NOW
    );
    expect(verdict.topReasons.map(r => r.reason)).toEqual(['b', 'c', 'd']);
  });
});

describe('silent rule', () => {
  it('ignores an overnight lull inside the longest closed gap', () => {
    // A nightly 10 hour gap is in the baseline every night, so a 12 hour wait is within 2 x 10.
    const nightly = steadySeries(1, back => back % 24 >= 14 && back % 24 < 24 && back >= 12);
    const gap = longestClosedGapHours(nightly);
    expect(gap).toBeGreaterThanOrEqual(10);
    const quietNow = nightly.filter(b => b.hourStart <= hourAgo(12));
    expect(evaluateClient(client(quietNow, lastHour()), NOW).rule).toBeNull();
  });

  it('fires on an outage longer than every closed gap', () => {
    const outage = steadySeries(1, back => back < 30);
    const verdict = evaluateClient(client(outage, lastHour()), NOW);
    expect(longestClosedGapHours(outage)).toBe(0);
    expect(verdict.silenceThresholdHours).toBe(SILENCE_FLOOR_HOURS);
    expect(verdict.rule).toBe('silent');
  });

  it('excludes the open gap from its own baseline', () => {
    const outage = steadySeries(1, back => back < 40);
    expect(longestClosedGapHours(outage)).toBe(0);
  });

  it('does not fire inside the silence floor', () => {
    const quiet = steadySeries(1, back => back < 4);
    expect(evaluateClient(client(quiet, lastHour()), NOW).rule).toBeNull();
  });

  it('fires once past the floor with no closed gaps', () => {
    const quiet = steadySeries(1, back => back < 8);
    expect(evaluateClient(client(quiet, lastHour()), NOW).rule).toBe('silent');
  });

  it('reports failing, not silent, when an app is failing and silent at once', () => {
    const quiet = steadySeries(1, back => back < 10);
    const verdict = evaluateClient(client(quiet, lastHour({ failures: 20, ourFaultFailures: 20 })), NOW);
    expect(verdict.rule).toBe('failing');
  });

  it('counts failures that follow a charge as failing: agent failures carry no success', () => {
    const quiet = steadySeries(1, back => back < 10);
    const verdict = evaluateClient(
      client(quiet, lastHour({ failures: 8, ourFaultFailures: 8, reasons: { agent_failed: 8 } })),
      NOW
    );
    expect(verdict.rule).toBe('failing');
    expect(verdict.topReasons[0]).toEqual({ reason: 'agent_failed', count: 8 });
  });
});

describe('platform rule', () => {
  const failing = (id: string) =>
    evaluateClient(client(steadySeries(), lastHour({ failures: 9, ourFaultFailures: 9 }), id), NOW);
  const healthy = (id: string) => evaluateClient(client(steadySeries(), lastHour({ successes: 4 }), id), NOW);
  const unarmed = (id: string) => evaluateClient(client([], lastHour({ failures: 30, ourFaultFailures: 30 }), id), NOW);

  it('fires once and mutes the per-client alerts when every armed client is down', () => {
    const verdicts = [failing('a'), failing('b'), unarmed('c')];
    expect(evaluatePlatform(verdicts).platformDown).toBe(true);
    const alerts = desiredAlerts(verdicts);
    expect(alerts.filter(a => a.scope === PLATFORM_SCOPE)).toEqual([
      { scope: PLATFORM_SCOPE, rule: PLATFORM_RULE, muted: false },
    ]);
    expect(alerts.filter(a => a.scope !== PLATFORM_SCOPE).every(a => a.muted)).toBe(true);
    expect(alerts).toHaveLength(3);
  });

  it('does not fire when one armed client is healthy', () => {
    const verdicts = [failing('a'), failing('b'), healthy('c')];
    expect(evaluatePlatform(verdicts).platformDown).toBe(false);
    const alerts = desiredAlerts(verdicts);
    expect(alerts.map(a => a.scope).sort()).toEqual(['a', 'b']);
    expect(alerts.every(a => !a.muted)).toBe(true);
  });

  it('gives a single armed app its own alert and no platform alert', () => {
    const verdicts = [failing('only'), unarmed('x')];
    expect(evaluatePlatform(verdicts).platformDown).toBe(false);
    expect(desiredAlerts(verdicts)).toEqual([
      expect.objectContaining({ scope: 'only', rule: 'failing', muted: false }),
    ]);
  });

  it('treats a mix of silent and failing armed apps as all down', () => {
    const silent = evaluateClient(
      client(
        steadySeries(1, back => back < 10),
        lastHour(),
        's'
      ),
      NOW
    );
    expect(silent.rule).toBe('silent');
    expect(evaluatePlatform([silent, failing('f')]).platformDown).toBe(true);
  });
});

describe('helpers', () => {
  it('orders reasons by count then name', () => {
    expect(topFailureReasons({ b: 2, a: 2, c: 1 }, 2)).toEqual([
      { reason: 'a', count: 2 },
      { reason: 'b', count: 2 },
    ]);
  });

  it('is due for a reminder after 24 hours or when never notified', () => {
    expect(reminderDue(undefined, NOW)).toBe(true);
    expect(reminderDue(new Date(NOW - REMINDER_INTERVAL_MS + 1), NOW)).toBe(false);
    expect(reminderDue(new Date(NOW - REMINDER_INTERVAL_MS), NOW)).toBe(true);
  });

  it('keeps the day constant honest', () => {
    expect(DAY_MS).toBe(24 * HOUR_MS);
  });
});
