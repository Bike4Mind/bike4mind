import { describe, expect, it, vi } from 'vitest';
import {
  REVIEW_ALERT_IN_FLIGHT_MINUTES,
  REVIEW_ALERT_LOST_HOURS,
  REVIEW_SWEEP_BATCH_LIMIT,
  REVIEW_SWEEP_REMINDER_LIMIT,
  REVIEW_SWEEP_SEND_BUDGET_MS,
  runIncidentReviewSweep,
  type IncidentReviewSweepDeps,
} from './incidentReviewSweep';
import type { RecordedIncident } from './incidentReviewAlerts';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const incident = (id: string, ageMinutes: number): RecordedIncident => ({
  id,
  createdAt: minutesAgo(ageMinutes),
  surface: 'generation',
});
const escalatedIncident = (id: string, ageMinutes: number): RecordedIncident => ({
  ...incident(id, ageMinutes),
  escalatedAt: minutesAgo(10),
});

function setup(
  data: {
    unalerted?: RecordedIncident[];
    due?: RecordedIncident[];
    oldestPending?: RecordedIncident;
    pendingCount?: number;
    /** Pending and not yet escalated, of any age: the fake finder applies the cutoff. */
    unescalated?: RecordedIncident[];
    /** Escalated and still owed an escalation email. */
    escalationUnalerted?: RecordedIncident[];
    /** Escalated and due a reminder to the second reviewers. */
    escalationDue?: RecordedIncident[];
  } = {},
  overrides: Partial<IncidentReviewSweepDeps> = {}
) {
  const unalerted = data.unalerted ?? [];
  const unescalated = data.unescalated ?? [];
  const owed = [...(data.escalationUnalerted ?? [])];
  const deps: IncidentReviewSweepDeps = {
    incidents: {
      findUnalerted: vi.fn().mockImplementation(async (_cutoff: Date, limit: number) => unalerted.slice(0, limit)),
      findDueForReminder: vi.fn().mockResolvedValue(data.due ?? []),
      findOldestPending: vi.fn().mockResolvedValue(data.oldestPending),
      countPending: vi.fn().mockResolvedValue(data.pendingCount ?? (data.due ?? []).length),
      markAlerted: vi.fn().mockResolvedValue(undefined),
      markAlertQueued: vi.fn().mockResolvedValue(undefined),
      markReminded: vi.fn().mockResolvedValue(undefined),
      findDueForEscalation: vi
        .fn()
        .mockImplementation(async (createdBefore: Date, limit: number) =>
          unescalated.filter(row => new Date(row.createdAt) <= createdBefore).slice(0, limit)
        ),
      escalateOnTimeout: vi.fn().mockImplementation(async (id: string, at: Date) => {
        const row = unescalated.find(candidate => candidate.id === id);
        if (!row) return null;
        const escalated = { ...row, escalatedAt: at };
        owed.push(escalated);
        return escalated;
      }),
      findEscalationUnalerted: vi.fn().mockImplementation(async (limit: number) => owed.slice(0, limit)),
      markEscalationAlerted: vi.fn().mockResolvedValue(undefined),
      markEscalationAlertQueued: vi.fn().mockResolvedValue(undefined),
      findDueForEscalationReminder: vi.fn().mockResolvedValue(data.escalationDue ?? []),
      markEscalationReminded: vi.fn().mockResolvedValue(undefined),
    },
    getRecipients: vi.fn().mockResolvedValue(['reviewer-one@example.com']),
    getEscalationRecipients: vi.fn().mockResolvedValue([]),
    sendEmail: vi.fn().mockResolvedValue({ messageId: 'm-1' }),
    appUrl: () => 'https://app.example',
    logger: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
  return deps;
}

describe('runIncidentReviewSweep', () => {
  it('re-sends the alert for an unalerted incident and stamps alertedAt', async () => {
    const deps = setup({ unalerted: [incident('inc-1', 40)] });

    const result = await runIncidentReviewSweep(deps, NOW);

    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.sendEmail).mock.calls[0][0]).toBe('reviewer-one@example.com');
    expect(vi.mocked(deps.sendEmail).mock.calls[0][1].subject).toBe('Moderation review pending');
    expect(deps.incidents.markAlerted).toHaveBeenCalledWith('inc-1', NOW);
    expect(deps.incidents.markReminded).not.toHaveBeenCalled();
    expect(result).toMatchObject({ alerted: 1, reminded: 0, failed: 0 });
  });

  it('only considers incidents at least 15 minutes old for the alert', async () => {
    const deps = setup();

    await runIncidentReviewSweep(deps, NOW);

    expect(deps.incidents.findUnalerted).toHaveBeenNthCalledWith(
      1,
      minutesAgo(15),
      REVIEW_SWEEP_BATCH_LIMIT,
      minutesAgo(REVIEW_ALERT_IN_FLIGHT_MINUTES),
      minutesAgo(REVIEW_ALERT_LOST_HOURS * 60)
    );
    // The alarm read counts a queued alert as unalerted until the worker confirms it.
    expect(deps.incidents.findUnalerted).toHaveBeenLastCalledWith(NOW, 1, NOW, NOW);
  });

  it('stamps alertQueuedAt, not alertedAt, when the alert is queued for the email-send worker', async () => {
    const deps = setup(
      { unalerted: [incident('inc-1', 40)] },
      { sendEmail: vi.fn().mockResolvedValue({ queued: true }) }
    );

    const result = await runIncidentReviewSweep(deps, NOW);

    expect(deps.incidents.markAlertQueued).toHaveBeenCalledWith('inc-1', NOW);
    expect(deps.incidents.markAlerted).not.toHaveBeenCalled();
    expect(result).toMatchObject({ alerted: 1, failed: 0 });
  });

  it('resends a queued alert with no outcome only after the lost window, not the in-flight one', async () => {
    const row = incident('inc-1', 40);
    const queuedAt = new Map<string, Date>();
    const deps = setup({}, { sendEmail: vi.fn().mockResolvedValue({ queued: true }) });
    // Same rule as ImageModerationIncidentRepository.findUnalerted with no failed copy recorded.
    vi.mocked(deps.incidents.findUnalerted).mockImplementation(async (_cutoff, limit, _queuedBefore, lostBefore) =>
      [row].filter(r => !queuedAt.has(r.id) || queuedAt.get(r.id)! <= lostBefore).slice(0, limit)
    );
    vi.mocked(deps.incidents.markAlertQueued).mockImplementation(async (id, at) => {
      queuedAt.set(id, at);
    });

    await runIncidentReviewSweep(deps, NOW);
    await runIncidentReviewSweep(deps, new Date(NOW.getTime() + (REVIEW_ALERT_IN_FLIGHT_MINUTES + 1) * 60_000));
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);

    await runIncidentReviewSweep(deps, new Date(NOW.getTime() + (REVIEW_ALERT_LOST_HOURS * 60 + 1) * 60_000));
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('sends one digest per reviewer for everything due, and stamps every incident it covered', async () => {
    const deps = setup(
      {
        due: [incident('inc-2', 3000), incident('inc-2b', 2000)],
        oldestPending: incident('inc-2', 3000),
        pendingCount: 5,
      },
      { getRecipients: vi.fn().mockResolvedValue(['reviewer-one@example.com', 'reviewer-two@example.com']) }
    );

    const result = await runIncidentReviewSweep(deps, NOW);

    expect(deps.incidents.findDueForReminder).toHaveBeenCalledWith(minutesAgo(24 * 60), REVIEW_SWEEP_REMINDER_LIMIT);
    expect(vi.mocked(deps.sendEmail).mock.calls.map(call => call[0])).toEqual([
      'reviewer-one@example.com',
      'reviewer-two@example.com',
    ]);
    const email = vi.mocked(deps.sendEmail).mock.calls[0][1];
    expect(email.subject).toBe('Moderation reviews still pending');
    expect(email.html).toContain('>5<');
    expect(email.html).toContain('50 hours');
    expect(email.html).toContain('https://app.example/admin');
    expect(email.html).not.toContain('inc-2');
    expect(deps.incidents.markReminded).toHaveBeenCalledExactlyOnceWith(['inc-2', 'inc-2b'], NOW);
    expect(deps.incidents.markAlerted).not.toHaveBeenCalled();
    expect(result).toMatchObject({ alerted: 0, reminded: 2, failed: 0 });
  });

  it('sends no digest when nothing is due', async () => {
    const deps = setup({ oldestPending: incident('inc-2c', 600) });

    const result = await runIncidentReviewSweep(deps, NOW);

    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.incidents.markReminded).not.toHaveBeenCalled();
    expect(result.reminded).toBe(0);
  });

  it('leaves a failed digest unstamped so the next run retries it', async () => {
    const deps = setup({ due: [incident('inc-2d', 3000)] }, { sendEmail: vi.fn().mockResolvedValue(false) });

    const result = await runIncidentReviewSweep(deps, NOW);

    expect(deps.incidents.markReminded).not.toHaveBeenCalled();
    expect(result).toMatchObject({ reminded: 0, failed: 1 });
  });

  it('sends a digest only to reviewers, never while none is configured', async () => {
    const deps = setup({ due: [incident('inc-2e', 3000)] }, { getRecipients: vi.fn().mockResolvedValue([]) });

    await runIncidentReviewSweep(deps, NOW);

    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.incidents.markReminded).not.toHaveBeenCalled();
  });

  it('sends nothing and flags the gap when no reviewer is configured but an incident is pending', async () => {
    const pending = incident('inc-3', 90);
    const deps = setup(
      { unalerted: [pending], oldestPending: pending },
      { getRecipients: vi.fn().mockResolvedValue([]) }
    );

    const result = await runIncidentReviewSweep(deps, NOW);

    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.incidents.markAlerted).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      pendingWithoutReviewers: true,
      oldestUnalertedAgeMinutes: 90,
      oldestPendingAgeMinutes: 90,
    });
    expect(deps.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not flag a missing reviewer list while nothing is pending', async () => {
    const deps = setup({}, { getRecipients: vi.fn().mockResolvedValue('not a list') });

    const result = await runIncidentReviewSweep(deps, NOW);

    expect(result.pendingWithoutReviewers).toBe(false);
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it('leaves a failed send unstamped so the next run retries it, and keeps the incident in the age', async () => {
    const pending = incident('inc-4', 45);
    const deps = setup(
      { unalerted: [pending], oldestPending: pending },
      { sendEmail: vi.fn().mockResolvedValue(false) }
    );

    const result = await runIncidentReviewSweep(deps, NOW);

    expect(deps.incidents.markAlerted).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      alerted: 0,
      failed: 1,
      oldestUnalertedAgeMinutes: 45,
      pendingWithoutReviewers: false,
    });
  });

  it('keeps going when one incident throws, logging its id alone', async () => {
    const deps = setup(
      { unalerted: [incident('inc-5', 60), incident('inc-6', 50)] },
      {
        sendEmail: vi
          .fn()
          .mockRejectedValueOnce(new Error('smtp down for reviewer-one@example.com'))
          .mockResolvedValue({ messageId: 'm-2' }),
      }
    );

    const result = await runIncidentReviewSweep(deps, NOW);

    expect(result).toMatchObject({ alerted: 1, failed: 1 });
    expect(deps.incidents.markAlerted).toHaveBeenCalledTimes(1);
    expect(deps.incidents.markAlerted).toHaveBeenCalledWith('inc-6', NOW);
    expect(deps.logger.error).toHaveBeenCalledWith(expect.any(String), { incidentId: 'inc-5', errorName: 'Error' });
  });

  it('logs when a delivered alert could not be stamped, and still counts it as sent', async () => {
    const deps = setup({ unalerted: [incident('inc-7', 30)] });
    vi.mocked(deps.incidents.markAlerted).mockRejectedValue(new Error('write failed'));

    const result = await runIncidentReviewSweep(deps, NOW);

    expect(result.alerted).toBe(1);
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining('alertedAt was not recorded'), {
      incidentId: 'inc-7',
      errorName: 'Error',
    });
    expect(JSON.stringify(vi.mocked(deps.logger.error).mock.calls)).not.toContain('write failed');
  });

  it('reports the oldest pending age even when everything is alerted', async () => {
    const deps = setup({ oldestPending: incident('inc-8', 26 * 60) });

    const result = await runIncidentReviewSweep(deps, NOW);

    expect(result).toMatchObject({ oldestPendingAgeMinutes: 26 * 60, oldestUnalertedAgeMinutes: 0 });
  });

  it('never puts an address or anything but the incident id in a log, and keeps the email metadata only', async () => {
    // A stored row carries far more than the alert may read; the sweep must not pass it on.
    const stored = { ...incident('inc-9', 60), userId: 'user-7f3a', labels: [{ name: 'Category A' }] };
    const deps = setup({ unalerted: [stored], oldestPending: stored }, { sendEmail: vi.fn().mockResolvedValue(false) });

    await runIncidentReviewSweep(deps, NOW);

    const logged = JSON.stringify([vi.mocked(deps.logger.warn).mock.calls, vi.mocked(deps.logger.error).mock.calls]);
    expect(logged).not.toContain('reviewer-one@example.com');
    const html = vi.mocked(deps.sendEmail).mock.calls[0][1].html;
    expect(html).toContain('inc-9');
    expect(html).not.toContain('user-7f3a');
    expect(html).not.toContain('Category A');
  });

  it('reads the reviewer list once per run, however many incidents it sends', async () => {
    const deps = setup({
      unalerted: [incident('inc-10', 60), incident('inc-11', 50)],
      due: [incident('inc-12', 3000)],
    });

    await runIncidentReviewSweep(deps, NOW);

    expect(deps.sendEmail).toHaveBeenCalledTimes(3);
    expect(deps.getRecipients).toHaveBeenCalledTimes(1);
    expect(deps.getEscalationRecipients).toHaveBeenCalledTimes(1);
  });

  it('waits past the request-path send timeout before counting a slow send as failed', async () => {
    vi.useFakeTimers();
    try {
      const deps = setup(
        { unalerted: [incident('inc-13', 60)] },
        { sendEmail: vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({}), 10_000))) }
      );

      const run = runIncidentReviewSweep(deps, NOW);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(run).resolves.toMatchObject({ alerted: 1, failed: 0 });
      expect(deps.incidents.markAlerted).toHaveBeenCalledWith('inc-13', NOW);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts no new send once the run budget is spent, leaving the rest for the next run', async () => {
    const deps = setup({ unalerted: [incident('inc-14', 60), incident('inc-15', 50), incident('inc-16', 40)] });
    let elapsed = 0;
    vi.mocked(deps.sendEmail).mockImplementation(async () => {
      elapsed += REVIEW_SWEEP_SEND_BUDGET_MS / 2;
      return {};
    });

    const result = await runIncidentReviewSweep(deps, NOW, () => elapsed);

    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ alerted: 2, failed: 0 });
  });
  describe('second review step', () => {
    const DAY_MINUTES = 24 * 60;
    const escalationList = { getEscalationRecipients: vi.fn().mockResolvedValue(['second-one@example.com']) };
    const sentTo = (deps: IncidentReviewSweepDeps) => vi.mocked(deps.sendEmail).mock.calls.map(call => call[0]);

    it('escalates an incident pending just over 24 hours and leaves one just under alone', async () => {
      const deps = setup(
        { unescalated: [incident('inc-over', DAY_MINUTES + 1), incident('inc-under', DAY_MINUTES - 1)] },
        { getEscalationRecipients: vi.fn().mockResolvedValue(['second-one@example.com']) }
      );

      const result = await runIncidentReviewSweep(deps, NOW);

      expect(deps.incidents.findDueForEscalation).toHaveBeenCalledWith(
        minutesAgo(DAY_MINUTES),
        REVIEW_SWEEP_BATCH_LIMIT
      );
      expect(deps.incidents.escalateOnTimeout).toHaveBeenCalledExactlyOnceWith('inc-over', NOW);
      expect(result).toMatchObject({ escalated: 1, escalationAlerted: 1, failed: 0 });
    });

    it('emails the escalation list about a fresh timeout and stamps escalationAlertedAt', async () => {
      const deps = setup(
        { unescalated: [incident('inc-timeout', DAY_MINUTES + 30)] },
        { getEscalationRecipients: vi.fn().mockResolvedValue(['second-one@example.com', 'second-two@example.com']) }
      );

      await runIncidentReviewSweep(deps, NOW);

      expect(sentTo(deps)).toEqual(['second-one@example.com', 'second-two@example.com']);
      const email = vi.mocked(deps.sendEmail).mock.calls[0][1];
      expect(email.subject).toBe('Moderation review escalated');
      expect(email.html).toContain('inc-timeout');
      expect(deps.incidents.markEscalationAlerted).toHaveBeenCalledExactlyOnceWith('inc-timeout', NOW);
    });

    it('does not count an incident another path escalated or decided first', async () => {
      const deps = setup({ unescalated: [incident('inc-raced', DAY_MINUTES + 5)] }, escalationList);
      vi.mocked(deps.incidents.escalateOnTimeout).mockResolvedValue(null);

      const result = await runIncidentReviewSweep(deps, NOW);

      expect(result.escalated).toBe(0);
      expect(deps.sendEmail).not.toHaveBeenCalled();
    });

    it('retries an escalation email that was not delivered earlier, manual or automatic', async () => {
      const deps = setup({ escalationUnalerted: [escalatedIncident('inc-manual', 120)] }, escalationList);

      const result = await runIncidentReviewSweep(deps, NOW);

      expect(deps.incidents.escalateOnTimeout).not.toHaveBeenCalled();
      expect(sentTo(deps)).toEqual(['second-one@example.com']);
      expect(deps.incidents.markEscalationAlerted).toHaveBeenCalledWith('inc-manual', NOW);
      expect(result).toMatchObject({ escalated: 0, escalationAlerted: 1 });
    });

    it('leaves a failed escalation email unstamped so the next run retries it', async () => {
      const deps = setup(
        { escalationUnalerted: [escalatedIncident('inc-failed', 120)] },
        { ...escalationList, sendEmail: vi.fn().mockResolvedValue(false) }
      );

      const result = await runIncidentReviewSweep(deps, NOW);

      expect(deps.incidents.markEscalationAlerted).not.toHaveBeenCalled();
      expect(result).toMatchObject({ escalationAlerted: 0, failed: 1 });
    });

    it('still escalates with an empty escalation list, sends nothing, and warns once', async () => {
      const deps = setup({
        unescalated: [incident('inc-a', DAY_MINUTES + 10), incident('inc-b', DAY_MINUTES + 5)],
        escalationUnalerted: [escalatedIncident('inc-c', 3000)],
      });
      vi.mocked(deps.getRecipients).mockResolvedValue([]);

      const result = await runIncidentReviewSweep(deps, NOW);

      expect(result.escalated).toBe(2);
      expect(deps.sendEmail).not.toHaveBeenCalled();
      expect(deps.incidents.markEscalationAlerted).not.toHaveBeenCalled();
      const escalationWarns = vi
        .mocked(deps.logger.warn)
        .mock.calls.filter(([message]) => message.includes('ImageModerationEscalationEmails'));
      expect(escalationWarns).toEqual([
        [
          '[ImageModeration] incidents were escalated but no escalation reviewer is configured (ImageModerationEscalationEmails)',
          { oldestIncidentId: 'inc-c' },
        ],
      ]);
    });

    it('does not warn about the escalation list while nothing is escalated', async () => {
      const deps = setup({ oldestPending: incident('inc-young', 60) });

      await runIncidentReviewSweep(deps, NOW);

      expect(deps.logger.warn).not.toHaveBeenCalled();
    });

    it('caps escalation stamps and sends per run', async () => {
      const many = Array.from({ length: REVIEW_SWEEP_BATCH_LIMIT + 5 }, (_, i) => incident(`inc-${i}`, 2000 + i));
      const deps = setup({ unescalated: many }, escalationList);

      const result = await runIncidentReviewSweep(deps, NOW);

      expect(result.escalated).toBe(REVIEW_SWEEP_BATCH_LIMIT);
      expect(deps.incidents.findEscalationUnalerted).toHaveBeenCalledWith(
        REVIEW_SWEEP_BATCH_LIMIT,
        minutesAgo(REVIEW_ALERT_IN_FLIGHT_MINUTES),
        minutesAgo(REVIEW_ALERT_LOST_HOURS * 60)
      );
      expect(result.escalationAlerted).toBe(REVIEW_SWEEP_BATCH_LIMIT);
    });

    it('starts no escalation email once the run budget is spent', async () => {
      const deps = setup(
        { escalationUnalerted: [escalatedIncident('inc-e1', 100), escalatedIncident('inc-e2', 90)] },
        escalationList
      );
      let elapsed = 0;
      vi.mocked(deps.sendEmail).mockImplementation(async () => {
        elapsed += REVIEW_SWEEP_SEND_BUDGET_MS;
        return {};
      });

      const result = await runIncidentReviewSweep(deps, NOW, () => elapsed);

      expect(deps.sendEmail).toHaveBeenCalledTimes(1);
      expect(result.escalationAlerted).toBe(1);
    });

    it('sends the second reviewers their own digest for escalated incidents that are due, and stamps them', async () => {
      const deps = setup(
        {
          due: [incident('inc-d1', 3000)],
          escalationDue: [escalatedIncident('inc-d2', 2600)],
          oldestPending: incident('inc-d1', 3000),
          pendingCount: 4,
        },
        escalationList
      );

      const result = await runIncidentReviewSweep(deps, NOW);

      expect(sentTo(deps)).toEqual(['reviewer-one@example.com', 'second-one@example.com']);
      const [, escalationDigest] = vi.mocked(deps.sendEmail).mock.calls[1];
      expect(escalationDigest.subject).toBe('Moderation reviews still pending');
      expect(escalationDigest.html).toContain('>4<');
      expect(escalationDigest.html).toContain('50 hours');
      expect(escalationDigest.html).not.toContain('inc-d');
      expect(deps.incidents.findDueForEscalationReminder).toHaveBeenCalledWith(
        minutesAgo(DAY_MINUTES),
        REVIEW_SWEEP_REMINDER_LIMIT
      );
      expect(deps.incidents.markReminded).toHaveBeenCalledExactlyOnceWith(['inc-d1'], NOW);
      expect(deps.incidents.markEscalationReminded).toHaveBeenCalledExactlyOnceWith(['inc-d2'], NOW);
      expect(result).toMatchObject({ reminded: 1, escalationReminded: 1, failed: 0 });
    });

    it('reminds the second reviewers while the first reviewer list is empty', async () => {
      const deps = setup(
        { escalationDue: [escalatedIncident('inc-d5', 2600)], oldestPending: incident('inc-d5', 2600) },
        { ...escalationList, getRecipients: vi.fn().mockResolvedValue([]) }
      );

      const result = await runIncidentReviewSweep(deps, NOW);

      expect(sentTo(deps)).toEqual(['second-one@example.com']);
      expect(deps.incidents.markReminded).not.toHaveBeenCalled();
      expect(deps.incidents.markEscalationReminded).toHaveBeenCalledExactlyOnceWith(['inc-d5'], NOW);
      expect(result).toMatchObject({ reminded: 0, escalationReminded: 1, failed: 0 });
    });

    it('reminds the second reviewers even when the first digest is undelivered', async () => {
      const deps = setup(
        { due: [incident('inc-d6', 3000)], escalationDue: [escalatedIncident('inc-d4', 2600)] },
        escalationList
      );
      vi.mocked(deps.sendEmail).mockImplementation(async to => {
        if (to === 'reviewer-one@example.com') throw new Error('smtp down');
        return { messageId: 'm-2' };
      });

      const result = await runIncidentReviewSweep(deps, NOW);

      expect(deps.incidents.markReminded).not.toHaveBeenCalled();
      expect(deps.incidents.markEscalationReminded).toHaveBeenCalledExactlyOnceWith(['inc-d4'], NOW);
      expect(result).toMatchObject({ reminded: 0, escalationReminded: 1, failed: 1 });
    });

    it('leaves a failed escalation digest unstamped so the next run retries it', async () => {
      const deps = setup({ escalationDue: [escalatedIncident('inc-d7', 2600)] }, escalationList);
      vi.mocked(deps.sendEmail).mockRejectedValue(new Error('smtp down'));

      const result = await runIncidentReviewSweep(deps, NOW);

      expect(sentTo(deps)).toEqual(['second-one@example.com']);
      expect(deps.incidents.markEscalationReminded).not.toHaveBeenCalled();
      expect(result).toMatchObject({ escalationReminded: 0, failed: 1 });
    });

    it('keeps the digest to the first list only while no escalated incident is due', async () => {
      const deps = setup({ due: [incident('inc-d3', 3000)] }, escalationList);

      await runIncidentReviewSweep(deps, NOW);

      expect(sentTo(deps)).toEqual(['reviewer-one@example.com']);
      expect(deps.incidents.markEscalationReminded).not.toHaveBeenCalled();
    });

    it('sends no escalation digest while the escalation list is empty', async () => {
      const deps = setup({ escalationDue: [escalatedIncident('inc-d8', 2600)] });

      const result = await runIncidentReviewSweep(deps, NOW);

      expect(deps.sendEmail).not.toHaveBeenCalled();
      expect(deps.incidents.markEscalationReminded).not.toHaveBeenCalled();
      expect(result.escalationReminded).toBe(0);
    });

    it('keeps the escalation email metadata only', async () => {
      const stored = {
        ...escalatedIncident('inc-meta', 3000),
        userId: 'user-7f3a',
        fabFileId: 'fabfile-0c12',
        storageKey: 'uploads/user-7f3a/file.png',
        labels: [{ name: 'Category A' }],
      };
      const deps = setup({ escalationUnalerted: [stored] }, escalationList);

      await runIncidentReviewSweep(deps, NOW);

      const html = vi.mocked(deps.sendEmail).mock.calls[0][1].html;
      expect(html).toContain('inc-meta');
      for (const leaked of ['user-7f3a', 'fabfile-0c12', 'uploads/', 'Category A']) expect(html).not.toContain(leaked);
      const logged = JSON.stringify([vi.mocked(deps.logger.warn).mock.calls, vi.mocked(deps.logger.error).mock.calls]);
      expect(logged).not.toContain('second-one@example.com');
    });
  });
});
