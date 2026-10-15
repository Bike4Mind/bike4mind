import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { CreditHolderType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { transformBatchRepository } from './TransformBatchModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

describe('TransformBatchRepository.claimCompletion', () => {
  it('hands the credit hold to exactly one of several concurrent claimers', async () => {
    const creditHold = {
      ownerId: 'u1',
      ownerType: CreditHolderType.User,
      userId: 'u1',
      organizationId: null,
      reservedCredits: 100,
      balanceAfterHold: 0,
    } as const;
    const row = await transformBatchRepository.create({
      ownerUserId: 'u1',
      anthropicBatchId: 'msgbatch_claim',
      status: 'in_progress',
      requestCount: 1,
      succeededCount: 0,
      erroredCount: 0,
      customIdMap: [{ customId: 'req_0', clientRef: 'a', model: 'm1' }],
      creditHold,
    });
    const update = { succeededCount: 1, erroredCount: 0, results: [] };

    const claims = await Promise.all(
      Array.from({ length: 5 }, () => transformBatchRepository.claimCompletion(row.id, update))
    );

    const winners = claims.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.creditHold).toMatchObject({ reservedCredits: 100 });
    const stored = await transformBatchRepository.findByAnthropicBatchId('msgbatch_claim');
    expect(stored).toMatchObject({ status: 'completed', creditHold: null, succeededCount: 1 });
    expect(await transformBatchRepository.claimCompletion(row.id, update)).toBeNull();
  });
});
