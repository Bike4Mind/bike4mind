import { describe, expect, it } from 'vitest';
import { buildFeedbackListFilter } from './feedbackListFilter';

describe('buildFeedbackListFilter', () => {
  it('bounds createdAt inclusively by a custom range, either end optional', async () => {
    const from = '2026-11-01T00:00:00.000Z';
    const to = '2026-11-08T23:59:59.999Z';
    expect(await buildFeedbackListFilter({ createdFrom: from, createdTo: to }, {}, true)).toEqual({
      $and: [{}, { createdAt: { $gte: new Date(from), $lte: new Date(to) } }],
    });
    expect(await buildFeedbackListFilter({ createdTo: to }, {}, true)).toEqual({
      $and: [{}, { createdAt: { $lte: new Date(to) } }],
    });
  });

  it('maps hasComment to an equality on contentStored, false included', async () => {
    expect(await buildFeedbackListFilter({ hasComment: true }, {}, true)).toEqual({
      $and: [{}, { contentStored: true }],
    });
    expect(await buildFeedbackListFilter({ hasComment: false }, {}, true)).toEqual({
      $and: [{}, { contentStored: false }],
    });
  });
});
