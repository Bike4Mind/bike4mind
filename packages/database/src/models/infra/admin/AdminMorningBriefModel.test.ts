import { describe, it, expect } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import { adminMorningBriefRepository as repository } from './AdminMorningBriefModel';

describe('AdminMorningBrief delivery persistence', () => {
  setupMongoTest();
  const brief = {
    _id: 'dev:2026-11-12',
    environment: 'dev',
    day: '2026-11-12',
    generatedAt: new Date('2026-11-12T08:00:00Z'),
    facts: 'Feedback: 3',
    summary: null,
    needsHuman: [],
  };
  it('preserves the first facts and permits exactly one concurrent delivery claim', async () => {
    await repository.saveOnce(brief);
    await repository.saveOnce({ ...brief, facts: 'changed' });
    const claims = await Promise.all([repository.claimDelivery(brief._id), repository.claimDelivery(brief._id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await repository.finishDelivery(brief._id, 'unconfirmed');
    expect(await repository.claimDelivery(brief._id)).toBeNull();
    expect(await repository.findLatest('dev')).toMatchObject({ facts: 'Feedback: 3', delivery: 'unconfirmed' });
    expect(await repository.findLatest('production')).toBeNull();
  });
});
