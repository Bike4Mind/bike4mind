import { describe, expect, it } from 'vitest';
import { CreditHolderType, type CreditHoldRecord } from '@bike4mind/common';
import { setupMongoTest } from '../../__test__/utils';
import { generationJobRepository } from '../ai/GenerationJobModel';
import { newAccountSpendCapAdapters } from './newAccountSpendCapAdapters';
import { pendingCreditHoldRepository } from './PendingCreditHoldModel';

const hold = (reservedCredits: number): CreditHoldRecord => ({
  ownerId: 'u1',
  ownerType: CreditHolderType.User,
  userId: 'u1',
  organizationId: null,
  reservedCredits,
  balanceAfterHold: 1000,
});

describe('newAccountSpendCapAdapters.personalSpendSince', () => {
  setupMongoTest();

  it('counts a queued generation job hold alongside outstanding request holds', async () => {
    await pendingCreditHoldRepository.record(hold(30), 'Chat', new Date(Date.now() + 60_000));
    await generationJobRepository.createJob({
      kind: 'video',
      ownerType: CreditHolderType.User,
      ownerId: 'u1',
      requestedBy: 'u1',
      source: 'studio',
      state: 'pending',
      payload: {
        request: {
          model: 'test-video',
          mode: 'text_to_video',
          prompt: 'p',
          durationSeconds: 4,
          aspectRatio: '16:9',
          resolution: '720p',
        },
        providerId: 'test',
      },
      pollCount: 0,
      attempts: 0,
      cancelRequested: false,
      deadlineAt: new Date(Date.now() + 20 * 60_000),
      creditHold: hold(70),
    });

    const samples = await newAccountSpendCapAdapters.personalSpendSince('u1', new Date(Date.now() - 60_000));
    expect(samples.map(sample => sample.credits).sort((a, b) => a - b)).toEqual([30, 70]);
  });
});
