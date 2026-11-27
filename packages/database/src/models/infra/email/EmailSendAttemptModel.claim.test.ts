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

const now = new Date('2026-03-01T12:00:00Z');
const staleBefore = new Date(now.getTime() - 150_000);
const claim = (id: string) =>
  repo.claimForSend(id, { now, staleBefore, renderedSubject: 's', renderedHtml: '<p>h</p>' });

describe('EmailSendAttemptRepository.claimForSend', () => {
  it('claims a PENDING attempt and stamps the lease and rendered mail', async () => {
    const id = await attemptIn(EmailSendStatus.PENDING);
    await expect(claim(id)).resolves.toBe(true);
    expect(await EmailSendAttempt.findById(id).lean()).toMatchObject({
      status: EmailSendStatus.PROCESSING,
      claimedAt: now,
      renderedSubject: 's',
      renderedHtml: '<p>h</p>',
    });
  });

  it('does not claim a PROCESSING attempt whose lease is still fresh', async () => {
    const id = await attemptIn(EmailSendStatus.PROCESSING, { claimedAt: new Date(now.getTime() - 10_000) });
    await expect(claim(id)).resolves.toBe(false);
  });

  it('reclaims a PROCESSING attempt whose lease went stale', async () => {
    const id = await attemptIn(EmailSendStatus.PROCESSING, { claimedAt: new Date(now.getTime() - 600_000) });
    await expect(claim(id)).resolves.toBe(true);
    expect((await EmailSendAttempt.findById(id).lean())?.claimedAt).toEqual(now);
  });

  it('never reclaims an attempt whose mail was already accepted, however stale', async () => {
    const id = await attemptIn(EmailSendStatus.PROCESSING, {
      claimedAt: new Date(now.getTime() - 600_000),
      sendAccepted: { at: new Date(now.getTime() - 590_000), queued: true },
    });
    await expect(claim(id)).resolves.toBe(false);
  });

  it('judges a lease-less PROCESSING attempt by updatedAt', async () => {
    const oldId = await attemptIn(EmailSendStatus.PROCESSING);
    const recentId = await attemptIn(EmailSendStatus.PROCESSING);
    await EmailSendAttempt.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(oldId) },
      { $set: { updatedAt: new Date(now.getTime() - 600_000) } }
    );
    await EmailSendAttempt.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(recentId) },
      { $set: { updatedAt: new Date(now.getTime() - 10_000) } }
    );
    await expect(claim(oldId)).resolves.toBe(true);
    await expect(claim(recentId)).resolves.toBe(false);
  });

  it('does not claim an attempt that already left PENDING/PROCESSING', async () => {
    for (const status of [EmailSendStatus.QUEUED, EmailSendStatus.SENT, EmailSendStatus.CANCELLED]) {
      const id = await attemptIn(status);
      await expect(claim(id)).resolves.toBe(false);
    }
  });
});

describe('EmailSendAttemptRepository.markSendAccepted', () => {
  const accepted = { at: new Date('2026-03-01T12:00:05Z'), queued: true };

  it('writes the marker on a PROCESSING attempt', async () => {
    const id = await attemptIn(EmailSendStatus.PROCESSING);
    await expect(repo.markSendAccepted(id, accepted)).resolves.toBe(true);
    expect((await EmailSendAttempt.findById(id).lean())?.sendAccepted).toEqual(accepted);
  });

  it('leaves an attempt the worker already resolved alone', async () => {
    const id = await attemptIn(EmailSendStatus.SENT);
    await expect(repo.markSendAccepted(id, accepted)).resolves.toBe(false);
  });
});
