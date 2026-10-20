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
const REVIEW_LINK = 'https://app.example/admin?tab=users&amp;incidentId=incident-123';

function setup(overrides: Partial<IncidentReviewAlertDeps> = {}) {
  const recorded: RecordedIncident = { ...INPUT, id: 'incident-123', createdAt: CREATED_AT };
  const deps: IncidentReviewAlertDeps = {
    incidents: { record: vi.fn().mockResolvedValue(recorded), markAlerted: vi.fn().mockResolvedValue(undefined) },
    getRecipients: vi.fn().mockResolvedValue(['reviewer-one@example.com', 'reviewer-two@example.com']),
    sendEmail: vi.fn().mockResolvedValue({ messageId: 'm-1' }),
    appUrl: () => 'https://app.example/',
    logger: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
  return { deps, recorded, incidents: withReviewerAlerts(deps) };
}

const sentEmail = (deps: IncidentReviewAlertDeps) => vi.mocked(deps.sendEmail).mock.calls[0][1];

describe('withReviewerAlerts', () => {
  it('alerts every configured reviewer when an incident needs review', async () => {
    const { deps, incidents } = setup();

    await incidents.record(INPUT);

    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.sendEmail).mock.calls[0][0]).toEqual([
      'reviewer-one@example.com',
      'reviewer-two@example.com',
    ]);
    const email = sentEmail(deps);
    expect(email.subject).toBe('Moderation review pending');
    expect(email.html).toContain('A moderation incident is waiting in the admin console.');
    expect(email.html).toContain('incident-123');
    expect(email.html).toContain(CREATED_AT.toISOString());
    expect(email.html).toContain('upload');
    expect(email.html).toContain(REVIEW_LINK);
  });

  it('records alertedAt only after the alert is delivered', async () => {
    const delivered = setup();
    await delivered.incidents.record(INPUT);
    expect(delivered.deps.incidents.markAlerted).toHaveBeenCalledWith('incident-123');

    const failed = setup({ sendEmail: vi.fn().mockResolvedValue(false) });
    await failed.incidents.record(INPUT);
    expect(failed.deps.incidents.markAlerted).not.toHaveBeenCalled();

    const unconfigured = setup({ getRecipients: vi.fn().mockResolvedValue([]) });
    await unconfigured.incidents.record(INPUT);
    expect(unconfigured.deps.incidents.markAlerted).not.toHaveBeenCalled();
  });

  it('does not alert for an incident recorded with a verdict already set', async () => {
    const { deps, incidents } = setup();
    vi.mocked(deps.incidents.record).mockResolvedValue({
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

    const email = sentEmail(deps);
    expect(Object.keys(email).sort()).toEqual(['html', 'subject']);
    const text = `${email.subject}\n${email.html}`;
    for (const forbidden of [
      INPUT.userId,
      INPUT.sessionId!,
      INPUT.questId!,
      INPUT.fabFileId!,
      INPUT.provider,
      INPUT.model,
      'Category A',
      'Parent B',
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
    expect(new Set(text.match(/https?:\/\/[^\s"<]+/g))).toEqual(new Set([REVIEW_LINK]));
  });

  it('does not fail the request when the alert cannot be sent', async () => {
    const onlyIncidentId = { incidentId: 'incident-123' };

    const rejecting = setup({
      sendEmail: vi.fn().mockRejectedValue(new Error('smtp down for reviewer-one@example.com')),
    });
    await expect(rejecting.incidents.record(INPUT)).resolves.toBe(rejecting.recorded);
    expect(rejecting.deps.logger.error).toHaveBeenCalledWith(expect.any(String), onlyIncidentId);

    const falsy = setup({ sendEmail: vi.fn().mockResolvedValue(false) });
    await expect(falsy.incidents.record(INPUT)).resolves.toBe(falsy.recorded);
    expect(falsy.deps.logger.error).toHaveBeenCalledWith(expect.any(String), onlyIncidentId);

    const noSettings = setup({ getRecipients: vi.fn().mockRejectedValue(new Error('db down')) });
    await expect(noSettings.incidents.record(INPUT)).resolves.toBe(noSettings.recorded);
    expect(noSettings.deps.logger.error).toHaveBeenCalledWith(expect.any(String), onlyIncidentId);

    const noStamp = setup();
    vi.mocked(noStamp.deps.incidents.markAlerted).mockRejectedValue(new Error('write failed'));
    await expect(noStamp.incidents.record(INPUT)).resolves.toBe(noStamp.recorded);
    expect(noStamp.deps.logger.error).toHaveBeenCalledWith(expect.any(String), onlyIncidentId);

    // No log line names a recipient.
    for (const { deps } of [rejecting, falsy, noSettings, noStamp]) {
      const logged = JSON.stringify([vi.mocked(deps.logger.error).mock.calls, vi.mocked(deps.logger.warn).mock.calls]);
      expect(logged).not.toContain('@example.com');
    }
  });

  it('does not wait on a stalled mail send', async () => {
    vi.useFakeTimers();
    try {
      const { deps, incidents, recorded } = setup({ sendEmail: vi.fn(() => new Promise<never>(() => {})) });
      const pending = incidents.record(INPUT);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toBe(recorded);
      expect(deps.logger.error).toHaveBeenCalledWith(expect.any(String), { incidentId: 'incident-123' });
      expect(deps.incidents.markAlerted).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends one alert per incident', async () => {
    const { deps, incidents } = setup({
      getRecipients: vi.fn().mockResolvedValue(['reviewer-one@example.com', 'Reviewer-One@example.com ']),
    });

    await incidents.record(INPUT);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.sendEmail).mock.calls[0][0]).toEqual(['reviewer-one@example.com']);

    // A failed write created no incident, so there is nothing to alert on.
    vi.mocked(deps.incidents.record).mockRejectedValueOnce(new Error('write failed'));
    await expect(incidents.record(INPUT)).rejects.toThrow('write failed');
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('still alerts the valid reviewers when one stored entry is invalid', async () => {
    const { deps, incidents } = setup({
      getRecipients: vi.fn().mockResolvedValue(['not-an-email', 'reviewer-one@example.com']),
    });

    await incidents.record(INPUT);

    expect(vi.mocked(deps.sendEmail).mock.calls[0][0]).toEqual(['reviewer-one@example.com']);
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid'), { incidentId: 'incident-123' });
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

    expect(sentEmail(deps).html).toContain('/admin?tab=users&amp;incidentId=incident-123');
  });
});
