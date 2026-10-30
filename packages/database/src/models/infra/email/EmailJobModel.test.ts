import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { EmailCategory, EmailJobStatus } from '@bike4mind/common';
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
