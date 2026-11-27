import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { StatusRunState } from './StatusRunStateModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

const epoch = new Date(0);
const now = new Date('2026-06-01T12:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);

const read = () => StatusRunState.collection.findOne({ _id: 'tick' as never });

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

afterEach(async () => {
  await StatusRunState.deleteMany({});
});

describe('StatusRunState.ensureRunState', () => {
  it('creates the single tick document with every lease and cooldown field at the epoch', async () => {
    await StatusRunState.ensureRunState();
    expect(await read()).toMatchObject({
      _id: 'tick',
      probeLease: { owner: '', until: epoch },
      publishLease: { owner: '', until: epoch },
      seq: 0,
      breakglassAppliedSeq: 0,
      dirtyDays: [],
      lastScheduledFinishedAt: epoch,
      lastManualStartedAt: epoch,
    });
  });

  it('leaves the run bookkeeping fields absent on a fresh document', async () => {
    await StatusRunState.ensureRunState();
    const doc = await StatusRunState.findById('tick').lean();
    for (const key of ['lastTrigger', 'probesAsOf', 'lastStartedAt', 'lastFinishedAt']) {
      expect(doc).not.toHaveProperty(key);
    }
  });

  it('never modifies an existing document', async () => {
    await StatusRunState.ensureRunState();
    await StatusRunState.acquireLease('probeLease', 'a', now, 55_000);
    await StatusRunState.updateOne({ _id: 'tick' }, { $set: { seq: 7, lastManualActorId: 'admin-1' } });
    const before = await read();

    await StatusRunState.ensureRunState();

    expect(await read()).toEqual(before);
  });

  it('is safe to call concurrently', async () => {
    await Promise.all(Array.from({ length: 10 }, () => StatusRunState.ensureRunState()));
    expect(await StatusRunState.countDocuments({})).toBe(1);
    expect(await read()).toMatchObject({ seq: 0, probeLease: { until: epoch } });
  });

  it('acquires the probe lease on a document first used for the publish lease', async () => {
    await StatusRunState.ensureRunState();
    await StatusRunState.acquireLease('publishLease', 'a', now, 55_000);
    expect(await StatusRunState.acquireLease('probeLease', 'a', now, 55_000)).not.toBeNull();
  });

  it('completes a document that a lease acquire cannot create on its own', async () => {
    expect(await StatusRunState.acquireLease('probeLease', 'a', now, 55_000)).toBeNull();
    await StatusRunState.ensureRunState();
    expect(await StatusRunState.acquireLease('probeLease', 'a', now, 55_000)).not.toBeNull();
  });
});

describe.each(['probeLease', 'publishLease'] as const)('StatusRunState %s', lease => {
  beforeAll(() => StatusRunState.ensureRunState());

  it('is acquired while free and stamped with the owner and expiry', async () => {
    await StatusRunState.ensureRunState();
    const doc = await StatusRunState.acquireLease(lease, 'a', now, 20_000);
    expect(doc?.[lease]).toEqual({ owner: 'a', until: at(20_000) });
  });

  it('is refused to another owner while unexpired', async () => {
    await StatusRunState.ensureRunState();
    await StatusRunState.acquireLease(lease, 'a', now, 20_000);

    expect(await StatusRunState.acquireLease(lease, 'b', at(19_999), 20_000)).toBeNull();
    expect((await read())?.[lease]).toEqual({ owner: 'a', until: at(20_000) });
  });

  it('is held at the exact expiry instant and taken over just after it', async () => {
    await StatusRunState.ensureRunState();
    await StatusRunState.acquireLease(lease, 'a', now, 20_000);

    expect(await StatusRunState.acquireLease(lease, 'b', at(20_000), 20_000)).toBeNull();
    const doc = await StatusRunState.acquireLease(lease, 'b', at(20_001), 20_000);
    expect(doc?.[lease]).toEqual({ owner: 'b', until: at(40_001) });
  });

  it('is refused to the owner that already holds it', async () => {
    await StatusRunState.ensureRunState();
    await StatusRunState.acquireLease(lease, 'a', now, 20_000);

    expect(await StatusRunState.acquireLease(lease, 'a', at(10_000), 20_000)).toBeNull();
  });

  it('is released only by its owner, to the epoch, keeping the field', async () => {
    await StatusRunState.ensureRunState();
    await StatusRunState.acquireLease(lease, 'a', now, 20_000);

    expect(await StatusRunState.releaseLease(lease, 'b')).toBe(false);
    expect((await read())?.[lease]).toEqual({ owner: 'a', until: at(20_000) });

    expect(await StatusRunState.releaseLease(lease, 'a')).toBe(true);
    expect((await read())?.[lease]).toEqual({ owner: 'a', until: epoch });
  });

  it('is free for anyone after release', async () => {
    await StatusRunState.ensureRunState();
    await StatusRunState.acquireLease(lease, 'a', now, 20_000);
    await StatusRunState.releaseLease(lease, 'a');

    expect(await StatusRunState.acquireLease(lease, 'b', now, 20_000)).not.toBeNull();
  });

  it('is independent of the other lease', async () => {
    await StatusRunState.ensureRunState();
    const other = lease === 'probeLease' ? 'publishLease' : 'probeLease';
    await StatusRunState.acquireLease(lease, 'a', now, 20_000);

    expect(await StatusRunState.acquireLease(other, 'b', now, 20_000)).not.toBeNull();
  });

  it('rejects an empty owner', async () => {
    await expect(StatusRunState.acquireLease(lease, '', now, 20_000)).rejects.toThrow();
  });
});
