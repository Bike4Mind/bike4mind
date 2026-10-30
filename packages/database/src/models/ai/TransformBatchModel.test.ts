import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { CreditHolderType, ModelBackend, type ModelInfo } from '@bike4mind/common';
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
    const billingModel: ModelInfo = {
      id: 'm1',
      name: 'm1',
      type: 'text',
      backend: ModelBackend.Anthropic,
      contextWindow: 200_000,
      max_tokens: 4096,
      supportsImageVariation: false,
      pricing: { 200_000: { input: 1e-6, output: 2e-6 } },
    };
    const row = await transformBatchRepository.create({
      ownerUserId: 'u1',
      anthropicBatchId: 'msgbatch_claim',
      status: 'in_progress',
      requestCount: 1,
      succeededCount: 0,
      erroredCount: 0,
      customIdMap: [{ customId: 'req_0', clientRef: 'a', model: 'm1' }],
      billingModels: { m1: billingModel },
      creditHold,
    });
    const update = { succeededCount: 1, erroredCount: 0 };

    const claims = await Promise.all(
      Array.from({ length: 5 }, () => transformBatchRepository.claimCompletion(row.id, update))
    );

    const winners = claims.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.creditHold).toMatchObject({ reservedCredits: 100 });
    expect(winners[0]?.billingModels?.m1).toMatchObject(billingModel);
    const stored = await transformBatchRepository.findByAnthropicBatchId('msgbatch_claim');
    expect(stored).toMatchObject({ status: 'completed', creditHold: { reservedCredits: 100 }, succeededCount: 1 });
    expect(await transformBatchRepository.claimCompletion(row.id, update)).toBeNull();
  });

  it('keeps the hold until marked settled, which clears it and stamps creditSettledAt once', async () => {
    const row = await transformBatchRepository.create({
      ownerUserId: 'u1',
      anthropicBatchId: 'msgbatch_twophase',
      status: 'in_progress',
      requestCount: 1,
      succeededCount: 0,
      erroredCount: 0,
      customIdMap: [],
      creditHold: { ownerId: 'u1', reservedCredits: 7 } as never,
    });
    await transformBatchRepository.claimCompletion(row.id, { succeededCount: 0, erroredCount: 1 });

    const claimedRow = await transformBatchRepository.findByAnthropicBatchId('msgbatch_twophase');
    expect(claimedRow).toMatchObject({ status: 'completed', creditHold: { reservedCredits: 7 } });
    expect(claimedRow?.results).toBeUndefined();
    expect(claimedRow?.creditSettledAt).toBeUndefined();

    const settlementStamps = await Promise.all(
      Array.from({ length: 3 }, () => transformBatchRepository.markCreditSettled(row.id))
    );
    expect(settlementStamps.filter(Boolean)).toHaveLength(1);
    await transformBatchRepository.saveResults(row.id, [{ client_ref: 'a', status: 'failed', error: 'x' }]);
    const done = await transformBatchRepository.findByAnthropicBatchId('msgbatch_twophase');
    expect(done).toMatchObject({ creditHold: null, results: [{ client_ref: 'a' }] });
    const settledAt = done?.creditSettledAt;
    expect(settledAt).toBeInstanceOf(Date);

    expect(await transformBatchRepository.markCreditSettled(row.id)).toBe(false);
    const again = await transformBatchRepository.findByAnthropicBatchId('msgbatch_twophase');
    expect(again?.creditSettledAt).toEqual(settledAt);
  });
});
