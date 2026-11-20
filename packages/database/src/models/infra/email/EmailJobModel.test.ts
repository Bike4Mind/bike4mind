import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { EmailCategory, EmailJobOverallStatus, EmailJobStatus } from '@bike4mind/common';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { EmailJob, emailJobRepository } from './EmailJobModel';

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
  await EmailJob.deleteMany({});
});

const createJob = (status: EmailJobStatus) =>
  EmailJob.create({
    name: 'Launch',
    templateId: 'tpl-1',
    category: EmailCategory.MARKETING,
    status,
    createdBy: 'admin-1',
  });

describe('EmailJobRepository.claimForStart', () => {
  it('moves a draft job to queued and records who started it', async () => {
    const job = await createJob(EmailJobStatus.DRAFT);

    const claimed = await emailJobRepository.claimForStart(job.id, { startedBy: 'admin-1' });

    expect(claimed?.status).toBe(EmailJobStatus.QUEUED);
    expect(claimed?.startedBy).toBe('admin-1');
  });

  it('returns null and leaves a job that was already started untouched', async () => {
    const job = await createJob(EmailJobStatus.QUEUED);

    const claimed = await emailJobRepository.claimForStart(job.id, { startedBy: 'admin-2' });

    expect(claimed).toBeNull();
    const stored = await EmailJob.findById(job.id);
    expect(stored?.status).toBe(EmailJobStatus.QUEUED);
    expect(stored?.startedBy).toBeUndefined();
  });

  it('returns null for a missing job', async () => {
    const claimed = await emailJobRepository.claimForStart(new mongoose.Types.ObjectId().toString());

    expect(claimed).toBeNull();
  });
});

describe('EmailJobRepository.completeRun', () => {
  const recount = {
    sentCount: 2,
    failedCount: 0,
    cancelledCount: 0,
    overallStatus: EmailJobOverallStatus.COMPLETE,
    completedAt: new Date('2026-01-02T00:00:00Z'),
  };

  it('completes the run whose lastSentAt it read', async () => {
    const lastSentAt = new Date('2026-01-01T00:00:00Z');
    const job = await createJob(EmailJobStatus.PROCESSING);
    await EmailJob.updateOne({ _id: job.id }, { $set: { lastSentAt } });

    expect(await emailJobRepository.completeRun(job.id, lastSentAt, 0, recount)).toBe(true);
    const stored = await EmailJob.findById(job.id);
    expect(stored?.status).toBe(EmailJobStatus.COMPLETED);
    expect(stored?.sentCount).toBe(2);
  });

  it('completes a job that was never claimed through a send (no lastSentAt)', async () => {
    const job = await createJob(EmailJobStatus.PROCESSING);
    expect(await emailJobRepository.completeRun(job.id, undefined, 0, recount)).toBe(true);
  });

  it('leaves a cancelled job cancelled', async () => {
    const job = await createJob(EmailJobStatus.CANCELLED);
    expect(await emailJobRepository.completeRun(job.id, undefined, 0, recount)).toBe(false);
    expect((await EmailJob.findById(job.id))?.status).toBe(EmailJobStatus.CANCELLED);
  });

  it('does not complete a job re-claimed for a newer send after the recount read it', async () => {
    const job = await createJob(EmailJobStatus.COMPLETED);
    await EmailJob.updateOne(
      { _id: job.id },
      { $set: { lastSentAt: new Date('2026-01-03T00:00:00Z'), overallStatus: EmailJobOverallStatus.SENDING } }
    );

    expect(await emailJobRepository.completeRun(job.id, undefined, 0, recount)).toBe(false);
    expect((await EmailJob.findById(job.id))?.overallStatus).toBe(EmailJobOverallStatus.SENDING);
  });

  it('refuses a recount write from a version another recount already advanced', async () => {
    const job = await createJob(EmailJobStatus.PROCESSING);
    const read = await emailJobRepository.findById(job.id);
    const version = (read as { __v?: number } | null)?.__v;
    expect(version).toBe(0);

    expect(
      await emailJobRepository.updateCounts(job.id, version, { sentCount: 1, failedCount: 1, cancelledCount: 0 })
    ).toBe(true);
    expect(
      await emailJobRepository.updateCounts(job.id, version, { sentCount: 2, failedCount: 0, cancelledCount: 0 })
    ).toBe(false);
    expect(await emailJobRepository.completeRun(job.id, undefined, version, recount)).toBe(false);

    const stored = await EmailJob.findById(job.id);
    expect(stored?.status).toBe(EmailJobStatus.PROCESSING);
    expect(stored?.sentCount).toBe(1);
    expect(stored?.failedCount).toBe(1);
    expect(await emailJobRepository.completeRun(job.id, undefined, 1, recount)).toBe(true);
  });
});
