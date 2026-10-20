import { describe, expect, it, vi } from 'vitest';
import type { ImageModerationIncident } from '@bike4mind/common';
import { withReviewerAlerts, type IncidentReviewAlertDeps, type RecordedIncident } from './incidentReviewAlerts';

const INPUT: ImageModerationIncident = {
  userId: 'user-7f3a',
  sessionId: 'session-91bc',
  questId: 'quest-44de',
  fabFileId: 'fabfile-0c12',
  provider: 'provider-x',
  model: 'model-y',
  surface: 'upload',
  labels: [{ name: 'Category A', parentName: 'Parent B', confidence: 97.5 }],
};

const CREATED_AT = new Date('2026-10-19T12:34:56.000Z');

function setup(overrides: Partial<IncidentReviewAlertDeps> = {}) {
  const recorded: RecordedIncident = { ...INPUT, id: 'incident-123', createdAt: CREATED_AT };
  const deps: IncidentReviewAlertDeps = {
    incidents: { record: vi.fn().mockResolvedValue(recorded) },
    getRecipients: vi.fn().mockResolvedValue(['reviewer-one@example.com', 'reviewer-two@example.com']),
    sendEmail: vi.fn().mockResolvedValue({ messageId: 'm-1' }),
    appUrl: () => 'https://app.example/',
    logger: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
  return { deps, recorded, incidents: withReviewerAlerts(deps) };
}

describe('withReviewerAlerts', () => {
  it('alerts every configured reviewer when an incident needs review', async () => {
    const { deps, incidents } = setup();

    await incidents.record(INPUT);

    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
    const recipients = vi.mocked(deps.sendEmail).mock.calls.map(([to]) => to);
    expect(recipients).toEqual(['reviewer-one@example.com', 'reviewer-two@example.com']);
    const [, email] = vi.mocked(deps.sendEmail).mock.calls[0];
    expect(email.html).toContain('incident-123');
    expect(email.html).toContain(CREATED_AT.toISOString());
    expect(email.html).toContain('upload');
    expect(email.html).toContain('Category A');
    expect(email.html).toContain('https://app.example/admin?tab=users&amp;incidentId=incident-123');
  });

  it('does not alert for an incident recorded with a verdict already set', async () => {
    const { deps, incidents } = setup();
    vi.mocked(deps.incidents.record).mockResolvedValue({
      ...INPUT,
      id: 'incident-123',
      createdAt: CREATED_AT,
      reviewStatus: 'false_positive',
    });

    await incidents.record(INPUT);

    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it('never includes image data, links to stored files, or user content in the alert', async () => {
    const { deps, incidents } = setup();
    // Fields a future incident shape could grow. The alert renders an allowlist, so none may leak.
    const leaky = {
      ...INPUT,
      id: 'incident-123',
      createdAt: CREATED_AT,
      prompt: 'PROMPT-TEXT-SENTINEL',
      userEmail: 'person@user-domain.example',
      s3Key: 'uploads/SENTINEL-KEY.png',
      imageUrl: 'https://bucket.example/SENTINEL-KEY.png?X-Amz-Signature=abc',
      thumbnail: 'data:image/png;base64,SENTINELBYTES',
      buffer: Buffer.from('SENTINEL-IMAGE-BYTES'),
    } as RecordedIncident;
    vi.mocked(deps.incidents.record).mockResolvedValue(leaky);

    await incidents.record(INPUT);

    expect(deps.sendEmail).toHaveBeenCalled();
    for (const [, email] of vi.mocked(deps.sendEmail).mock.calls) {
      expect(Object.keys(email).sort()).toEqual(['html', 'subject']);
      const text = `${email.subject}\n${email.html}`;
      for (const forbidden of [
        INPUT.userId,
        INPUT.sessionId!,
        INPUT.questId!,
        INPUT.fabFileId!,
        'SENTINEL',
        'person@user-domain.example',
        'data:image',
        'base64',
        'X-Amz',
        '<img',
      ]) {
        expect(text).not.toContain(forbidden);
      }
      // The only link is the admin console.
      expect(new Set(text.match(/https?:\/\/[^\s"<]+/g))).toEqual(
        new Set(['https://app.example/admin?tab=users&amp;incidentId=incident-123'])
      );
    }
  });

  it('does not fail the request when the alert cannot be sent', async () => {
    const rejecting = setup({
      sendEmail: vi.fn().mockRejectedValue(new Error('smtp down for reviewer-one@example.com')),
    });
    await expect(rejecting.incidents.record(INPUT)).resolves.toBe(rejecting.recorded);
    expect(rejecting.deps.logger.error).toHaveBeenCalledWith(expect.any(String), { incidentId: 'incident-123' });

    const falsy = setup({ sendEmail: vi.fn().mockResolvedValue(false) });
    await expect(falsy.incidents.record(INPUT)).resolves.toBe(falsy.recorded);
    expect(falsy.deps.logger.error).toHaveBeenCalledWith(expect.any(String), { incidentId: 'incident-123' });

    const noSettings = setup({ getRecipients: vi.fn().mockRejectedValue(new Error('db down')) });
    await expect(noSettings.incidents.record(INPUT)).resolves.toBe(noSettings.recorded);
    expect(noSettings.deps.logger.error).toHaveBeenCalledWith(expect.any(String), { incidentId: 'incident-123' });
  });

  it('does not wait on a stalled mail send', async () => {
    vi.useFakeTimers();
    try {
      const { deps, incidents, recorded } = setup({ sendEmail: vi.fn(() => new Promise<never>(() => {})) });
      const pending = incidents.record(INPUT);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toBe(recorded);
      expect(deps.logger.error).toHaveBeenCalledWith(expect.any(String), { incidentId: 'incident-123' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends one alert per incident', async () => {
    const { deps, incidents } = setup({ getRecipients: vi.fn().mockResolvedValue(['reviewer-one@example.com']) });

    await incidents.record(INPUT);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);

    // A failed write created no incident, so there is nothing to alert on.
    vi.mocked(deps.incidents.record).mockRejectedValueOnce(new Error('write failed'));
    await expect(incidents.record(INPUT)).rejects.toThrow('write failed');
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('dedupes a recipient listed twice', async () => {
    const { deps, incidents } = setup({
      getRecipients: vi.fn().mockResolvedValue(['reviewer-one@example.com', 'Reviewer-One@example.com ']),
    });

    await incidents.record(INPUT);

    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('warns when no reviewer is configured', async () => {
    const { deps, incidents } = setup({ getRecipients: vi.fn().mockResolvedValue([]) });

    await incidents.record(INPUT);

    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('ImageModerationReviewerEmails'), {
      incidentId: 'incident-123',
    });
  });

  it('still links the incident by path when the deploy has no app URL', async () => {
    const { deps, incidents } = setup({ appUrl: () => undefined });

    await incidents.record(INPUT);

    const [, email] = vi.mocked(deps.sendEmail).mock.calls[0];
    expect(email.html).toContain('/admin?tab=users&amp;incidentId=incident-123');
  });
});
