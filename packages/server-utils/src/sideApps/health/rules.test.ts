import { describe, expect, it } from 'vitest';
import {
  ARM_MIN_ACTIVE_DAYS,
  ARM_MIN_SUCCESSES,
  DAY_MS,
  FAIL_MIN_ATTEMPTS,
  GAP_LOOKBACK_DAYS,
  HOUR_MS,
  PLATFORM_RULE,
  PLATFORM_SCOPE,
  REMINDER_INTERVAL_MS,
  SILENCE_FLOOR_HOURS,
  SILENCE_MIN_HISTORY_DAYS,
  desiredAlerts,
  emptyWindowCounts,
  evaluateClient,
  evaluatePlatform,
  hourStartOf,
  longestClosedGapHours,
  reminderDue,
  topFailureReasons,
  untrackedAlerts,
  type ClientHealthInput,
  type ClientVerdict,
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

/** A steady app: successes every `every` hours for 7 days and a bit, so it is armed and past the silence history gate. */
const steadySeries = (every = 1, skip: (hoursBack: number) => boolean = () => false): HourlyBucket[] => {
  const series: HourlyBucket[] = [];
  for (let back = 7 * 24; back >= 0; back -= every) {
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

describe('weekday-only apps', () => {
  /** Successes 9:00-17:59 UTC on Monday to Friday, for the 16 days before `until`. */
  const weekdaySeries = (until: number, days = GAP_LOOKBACK_DAYS + 2): HourlyBucket[] => {
    const series: HourlyBucket[] = [];
    for (let hourStart = hourStartOf(until) - days * DAY_MS; hourStart < until; hourStart += HOUR_MS) {
      const at = new Date(hourStart);
      const weekday = at.getUTCDay() >= 1 && at.getUTCDay() <= 5;
      if (weekday && at.getUTCHours() >= 9 && at.getUTCHours() < 18) {
        series.push({ hourStart, successes: 3, failures: 0, ourFaultFailures: 0 });
      }
    }
    return series;
  };
  const saturday = Date.UTC(2026, 10, 21, 23);
  const sunday = Date.UTC(2026, 10, 22, 23);
  const within = (hourly: HourlyBucket[], now: number, days: number) =>
    hourly.filter(bucket => bucket.hourStart >= now - days * DAY_MS);

  it('is not silent over a weekend once the lookback holds the previous weekend', () => {
    for (const now of [saturday, sunday]) {
      const hourly = within(weekdaySeries(now), now, GAP_LOOKBACK_DAYS);
      const verdict = evaluateClient(client(hourly, lastHour()), now);
      expect(verdict.armed).toBe(true);
      expect(verdict.rule).toBeNull();
    }
  });

  it('does not judge silence on a 7-day baseline alone', () => {
    const hourly = within(weekdaySeries(sunday), sunday, 7);
    expect(evaluateClient(client(hourly, lastHour()), sunday).rule).toBeNull();
  });

  it('arms a new weekday app by Friday and keeps it quiet through its first weekend', () => {
    const wednesday = Date.UTC(2026, 10, 11);
    const hourly = weekdaySeries(Date.UTC(2026, 10, 14), 3).filter(bucket => bucket.hourStart >= wednesday);
    expect(new Date(hourly[0].hourStart).getUTCDay()).toBe(3);
    const friday = Date.UTC(2026, 10, 13, 18, 30);
    expect(evaluateClient(client(hourly, lastHour()), friday).armed).toBe(true);
    const sundayEarly = Date.UTC(2026, 10, 15, 1);
    const verdict = evaluateClient(client(hourly, lastHour()), sundayEarly);
    expect(verdict.armed).toBe(true);
    expect(verdict.hoursSinceSuccess).toBeGreaterThan(verdict.silenceThresholdHours);
    expect(verdict.rule).toBeNull();
  });

  it('goes silent once an app past the minimum history stops for longer than its closed gaps', () => {
    const now = Date.UTC(2026, 10, 21, 23);
    const hourly: HourlyBucket[] = [];
    for (let hourStart = hourStartOf(now) - 10 * DAY_MS; hourStart < now - 2 * DAY_MS; hourStart += HOUR_MS) {
      const hour = new Date(hourStart).getUTCHours();
      if (hour >= 9 && hour < 18) hourly.push({ hourStart, successes: 3, failures: 0, ourFaultFailures: 0 });
    }
    expect(now - hourly[0].hourStart).toBeGreaterThan(SILENCE_MIN_HISTORY_DAYS * DAY_MS);
    expect(evaluateClient(client(hourly, lastHour()), now).rule).toBe('silent');
    const young = hourly.filter(bucket => bucket.hourStart >= now - 6 * DAY_MS);
    expect(evaluateClient(client(young, lastHour()), now).rule).toBeNull();
  });

  it('still alerts when a daily app stops for longer than its closed gaps', () => {
    const now = Date.UTC(2026, 10, 21, 23);
    const daily: HourlyBucket[] = [];
    for (let hourStart = hourStartOf(now) - 14 * DAY_MS; hourStart < now - 2 * DAY_MS; hourStart += HOUR_MS) {
      const hour = new Date(hourStart).getUTCHours();
      if (hour >= 9 && hour < 18) daily.push({ hourStart, successes: 3, failures: 0, ourFaultFailures: 0 });
    }
    expect(evaluateClient(client(daily, lastHour()), now).rule).toBe('silent');
  });
});

describe('failing hysteresis', () => {
  const quiet = lastHour({ failures: FAIL_MIN_ATTEMPTS - 2 });

  it('does not open on a low-volume hour', () => {
    expect(evaluateClient(client(steadySeries(), quiet), NOW).rule).toBeNull();
  });

  it('keeps an open failing alert through a low-volume hour with no success', () => {
    expect(evaluateClient(client(steadySeries(), quiet), NOW, 'failing').rule).toBe('failing');
  });

  it('releases an open failing alert once an hour has a success and is not failing by rate', () => {
    expect(evaluateClient(client(steadySeries(), lastHour({ successes: 3 })), NOW, 'failing').rule).toBeNull();
  });

  it('keeps it open while the rate clause still fails', () => {
    const rate = lastHour({ successes: 2, failures: 8, ourFaultFailures: 8 });
    expect(evaluateClient(client(steadySeries(), rate), NOW, 'failing').rule).toBe('failing');
  });
});

describe('open alerts of unarmed clients', () => {
  const verdict = (partial: Partial<ClientVerdict>): ClientVerdict => ({
    clientId: 'app',
    armed: false,
    rule: null,
    lastHour: emptyWindowCounts(),
    hoursSinceSuccess: 200,
    silenceThresholdHours: SILENCE_FLOOR_HOURS,
    topReasons: [],
    ...partial,
  });
  const open = [{ scope: 'app', rule: 'silent' }];

  it('keeps the alert while the client has no recent success', () => {
    expect(desiredAlerts([verdict({})], open)).toMatchObject([{ scope: 'app', rule: 'silent', muted: false }]);
  });

  it('does not keep an alert for a client with no verdict, and reports it as untracked', () => {
    expect(desiredAlerts([], open)).toEqual([]);
    expect(untrackedAlerts([], open)).toEqual(open);
    expect(untrackedAlerts([verdict({})], open)).toEqual([]);
    expect(untrackedAlerts([], [{ scope: PLATFORM_SCOPE, rule: PLATFORM_RULE }])).toEqual([]);
  });

  it('drops it once the client has a success again', () => {
    expect(desiredAlerts([verdict({ hoursSinceSuccess: 0.4 })], open)).toEqual([]);
  });

  it('drops it for an armed client that no longer has a rule', () => {
    expect(desiredAlerts([verdict({ armed: true, hoursSinceSuccess: 2 })], open)).toEqual([]);
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
