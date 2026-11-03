import { describe, expect, it, vi } from 'vitest';
import {
  REVIEW_SWEEP_BATCH_LIMIT,
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

function setup(
  data: { unalerted?: RecordedIncident[]; due?: RecordedIncident[]; oldestPending?: RecordedIncident } = {},
  overrides: Partial<IncidentReviewSweepDeps> = {}
) {
  const unalerted = data.unalerted ?? [];
  const deps: IncidentReviewSweepDeps = {
    incidents: {
      findUnalerted: vi.fn().mockImplementation(async (_cutoff: Date, limit: number) => unalerted.slice(0, limit)),
      findDueForReminder: vi.fn().mockResolvedValue(data.due ?? []),
      findOldestPending: vi.fn().mockResolvedValue(data.oldestPending),
      markAlerted: vi.fn().mockResolvedValue(undefined),
      markReminded: vi.fn().mockResolvedValue(undefined),
    },
    getRecipients: vi.fn().mockResolvedValue(['reviewer-one@example.com']),
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

    expect(deps.incidents.findUnalerted).toHaveBeenNthCalledWith(1, minutesAgo(15), REVIEW_SWEEP_BATCH_LIMIT);
  });

  it('sends one reminder per 24 hours for an alerted incident still awaiting a verdict', async () => {
    const deps = setup({ due: [incident('inc-2', 3000)] });

    const result = await runIncidentReviewSweep(deps, NOW);

    expect(deps.incidents.findDueForReminder).toHaveBeenCalledWith(minutesAgo(24 * 60), REVIEW_SWEEP_BATCH_LIMIT);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    expect(deps.incidents.markReminded).toHaveBeenCalledWith('inc-2', NOW);
    expect(deps.incidents.markAlerted).not.toHaveBeenCalled();
    expect(result).toMatchObject({ alerted: 0, reminded: 1, failed: 0 });
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
    expect(deps.logger.error).toHaveBeenCalledWith(expect.any(String), { incidentId: 'inc-5' });
  });

  it('logs when a delivered alert could not be stamped, and still counts it as sent', async () => {
    const deps = setup({ unalerted: [incident('inc-7', 30)] });
    vi.mocked(deps.incidents.markAlerted).mockRejectedValue(new Error('write failed'));

    const result = await runIncidentReviewSweep(deps, NOW);

    expect(result.alerted).toBe(1);
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining('alertedAt was not recorded'), {
      incidentId: 'inc-7',
    });
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
});
