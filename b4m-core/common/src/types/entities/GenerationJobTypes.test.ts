import { describe, expect, it } from 'vitest';
import { questGenerationJobs } from './GenerationJobTypes';

describe('questGenerationJobs', () => {
  it('reads a legacy quest as video jobs', () => {
    expect(questGenerationJobs({ videoJobIds: ['v1', 'v2'] })).toEqual([
      { id: 'v1', kind: 'video' },
      { id: 'v2', kind: 'video' },
    ]);
  });

  it('reads generationJobs in order', () => {
    const jobs = [
      { id: 'm1', kind: 'music' as const },
      { id: 'v1', kind: 'video' as const },
    ];
    expect(questGenerationJobs({ generationJobs: jobs })).toEqual(jobs);
  });

  it('lists legacy jobs first and keeps one entry per id', () => {
    expect(
      questGenerationJobs({
        videoJobIds: ['v1'],
        generationJobs: [
          { id: 'v1', kind: 'video' },
          { id: 'm1', kind: 'music' },
        ],
      })
    ).toEqual([
      { id: 'v1', kind: 'video' },
      { id: 'm1', kind: 'music' },
    ]);
  });

  it('is empty for a quest with no jobs', () => {
    expect(questGenerationJobs({})).toEqual([]);
  });
});
