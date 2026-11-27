import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { DlqTriageDeliveryModel, dlqTriageDeliveryRepository } from './DlqTriageDeliveryModel';

describe('DLQ triage delivery claims', () => {
  let mongo: Awaited<ReturnType<typeof createMongoServer>>;
  beforeAll(async () => {
    mongo = await createMongoServer();
    await mongoose.connect(mongo.getUri());
    await DlqTriageDeliveryModel.init();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });
  it('allows exactly one concurrent claim and never retries unconfirmed delivery', async () => {
    const claims = await Promise.all(Array.from({ length: 5 }, () => dlqTriageDeliveryRepository.claim('fixture')));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await DlqTriageDeliveryModel.findOne({ key: 'fixture' }).lean())?.state).toBe('unconfirmed');
    expect(await dlqTriageDeliveryRepository.claim('fixture')).toBe(false);
    await dlqTriageDeliveryRepository.delivered('fixture');
    expect((await DlqTriageDeliveryModel.findOne({ key: 'fixture' }).lean())?.state).toBe('delivered');
  });
  it('retains claims beyond SQS maximum retention', () => {
    expect(DlqTriageDeliveryModel.schema.indexes()).toContainEqual([
      { createdAt: 1 },
      expect.objectContaining({ expireAfterSeconds: 30 * 24 * 60 * 60 }),
    ]);
  });
  it('releases unsent claims but never releases delivered notifications', async () => {
    expect(await dlqTriageDeliveryRepository.claim('unsent')).toBe(true);
    await dlqTriageDeliveryRepository.release('unsent');
    expect(await dlqTriageDeliveryRepository.claim('unsent')).toBe(true);
    await dlqTriageDeliveryRepository.delivered('unsent');
    await dlqTriageDeliveryRepository.release('unsent');
    expect(await dlqTriageDeliveryRepository.claim('unsent')).toBe(false);
  });
});
