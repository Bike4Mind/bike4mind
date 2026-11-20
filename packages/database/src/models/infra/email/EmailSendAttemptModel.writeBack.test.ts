import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { EmailSendStatus } from '@bike4mind/common';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { EmailSendAttempt, emailSendAttemptRepository as repo } from './EmailSendAttemptModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

afterEach(async () => {
  await EmailSendAttempt.deleteMany({});
});

let seq = 0;
async function attemptIn(status: EmailSendStatus, extra: Record<string, unknown> = {}) {
  seq++;
  const doc = await EmailSendAttempt.create({
    jobId: 'job-1',
    recipientId: `r-${seq}`,
    recipientType: 'direct',
    recipientEmail: `r${seq}@example.org`,
    trackingToken: `tok-${seq}`,
    status,
    ...extra,
  });
  return doc._id.toString();
}

const statusOf = async (id: string) => (await EmailSendAttempt.findById(id).lean())?.status;
const sent = { ok: true as const, at: new Date('2026-01-02T00:00:00Z') };
const failed = { ok: false as const, error: 'transport refused' };

describe('EmailSendAttemptRepository delivery write-back', () => {
  it('moves QUEUED to SENT and clears an earlier error', async () => {
    const id = await attemptIn(EmailSendStatus.QUEUED, { errorMessage: 'old' });
    await expect(repo.recordDeliveryOutcome(id, sent)).resolves.toBe('job-1');
    const doc = await EmailSendAttempt.findById(id).lean();
    expect(doc).toMatchObject({ status: EmailSendStatus.SENT, sentAt: sent.at });
    expect(doc?.errorMessage).toBeUndefined();
  });

  it('moves QUEUED to FAILED with the error and one more retry', async () => {
    const id = await attemptIn(EmailSendStatus.QUEUED, { retryCount: 1 });
    await repo.recordDeliveryOutcome(id, failed);
    expect(await EmailSendAttempt.findById(id).lean()).toMatchObject({
      status: EmailSendStatus.FAILED,
      errorMessage: 'transport refused',
      retryCount: 2,
    });
  });

  it('lets a retried send that succeeded move FAILED to SENT', async () => {
    const id = await attemptIn(EmailSendStatus.FAILED);
    await expect(repo.recordDeliveryOutcome(id, sent)).resolves.toBe('job-1');
    expect(await statusOf(id)).toBe(EmailSendStatus.SENT);
  });

  it.each([
    EmailSendStatus.SENT,
    EmailSendStatus.DELIVERED,
    EmailSendStatus.OPENED,
    EmailSendStatus.CLICKED,
    EmailSendStatus.BOUNCED,
    EmailSendStatus.COMPLAINED,
  ])('never downgrades %s', async status => {
    const id = await attemptIn(status);
    await expect(repo.recordDeliveryOutcome(id, failed)).resolves.toBeNull();
    if (status !== EmailSendStatus.SENT) await expect(repo.recordDeliveryOutcome(id, sent)).resolves.toBeNull();
    expect(await statusOf(id)).toBe(status);
  });

  it('records a worker failure that lands before markQueued on a cancelled attempt', async () => {
    const id = await attemptIn(EmailSendStatus.CANCELLED);
    await expect(repo.recordDeliveryOutcome(id, failed)).resolves.toBe('job-1');
    await expect(repo.markQueued(id, { sentAt: new Date(), retryCount: 0 })).resolves.toBe(false);
    expect(await statusOf(id)).toBe(EmailSendStatus.FAILED);
  });

  it('records a send that went out after a mid-publish cancel', async () => {
    const id = await attemptIn(EmailSendStatus.CANCELLED);
    await expect(repo.markQueued(id, { sentAt: new Date(), retryCount: 0 })).resolves.toBe(true);
    expect(await statusOf(id)).toBe(EmailSendStatus.QUEUED);
    await expect(repo.recordDeliveryOutcome(id, sent)).resolves.toBe('job-1');
    expect(await statusOf(id)).toBe(EmailSendStatus.SENT);
  });

  it('marks a processing attempt QUEUED', async () => {
    const id = await attemptIn(EmailSendStatus.PROCESSING);
    await expect(repo.markQueued(id, { sentAt: new Date(), retryCount: 0 })).resolves.toBe(true);
    expect(await statusOf(id)).toBe(EmailSendStatus.QUEUED);
  });

  it.each([
    ['SENT', sent, EmailSendStatus.SENT],
    ['FAILED', failed, EmailSendStatus.FAILED],
  ])('leaves a worker %s in place when the queue write lands second', async (_label, outcome, expected) => {
    const id = await attemptIn(EmailSendStatus.PROCESSING);
    await repo.recordDeliveryOutcome(id, outcome);
    await expect(repo.markQueued(id, { sentAt: new Date(), retryCount: 0 })).resolves.toBe(false);
    expect(await statusOf(id)).toBe(expected);
  });

  it('counts QUEUED attempts as sent in the job summary', async () => {
    await attemptIn(EmailSendStatus.QUEUED);
    await attemptIn(EmailSendStatus.QUEUED, { isTestEmail: true });
    const summary = await repo.getJobSummary('job-1');
    expect(summary.sent).toBe(2);
    expect(summary.testEmails.sent).toBe(1);
  });

  it('records the batch retry count with a synchronous success', async () => {
    const id = await attemptIn(EmailSendStatus.PROCESSING);
    await repo.recordDeliveryOutcome(id, sent, { retryCount: 2 });
    expect(await EmailSendAttempt.findById(id).lean()).toMatchObject({ status: EmailSendStatus.SENT, retryCount: 2 });
  });

  it('marks an attempt the batch gave up on FAILED while it is still processing', async () => {
    const id = await attemptIn(EmailSendStatus.PROCESSING);
    await expect(repo.markSendFailed(id, { errorMessage: 'gave up', retryCount: 3 })).resolves.toBe(true);
    expect(await EmailSendAttempt.findById(id).lean()).toMatchObject({
      status: EmailSendStatus.FAILED,
      errorMessage: 'gave up',
      retryCount: 3,
    });
  });

  it.each([EmailSendStatus.SENT, EmailSendStatus.QUEUED, EmailSendStatus.FAILED])(
    'never lets the batch give-up overwrite a %s the worker or a retry already wrote',
    async status => {
      const id = await attemptIn(status, { errorMessage: 'worker error' });
      await expect(repo.markSendFailed(id, { errorMessage: 'gave up', retryCount: 3 })).resolves.toBe(false);
      expect(await EmailSendAttempt.findById(id).lean()).toMatchObject({ status, errorMessage: 'worker error' });
    }
  );
});
