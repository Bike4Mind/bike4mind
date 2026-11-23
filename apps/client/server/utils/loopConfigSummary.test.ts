import { describe, expect, it } from 'vitest';
import { loopConfigChangeSummary } from './loopConfigSummary';

const base = {
  stages: ['todo', 'doing', 'done'],
  stageConfig: null,
  model: 'model-a',
  budgetCreditsPerDay: 200,
  tools: ['web_search'],
};

describe('loopConfigChangeSummary', () => {
  it('is empty when nothing it tracks changed', () => {
    expect(loopConfigChangeSummary(base, { ...base })).toBe('');
  });

  it('summarizes stages, budget, model and tools', () => {
    const summary = loopConfigChangeSummary(base, {
      ...base,
      stages: ['todo', 'doing', 'review', 'done'],
      budgetCreditsPerDay: 300,
      model: 'model-b',
      tools: ['fetch'],
    });
    expect(summary).toBe('stage "review" added; model model-a -> model-b; budget 200 -> 300; tools +fetch -web_search');
  });

  it('notes a cleared budget, stage config, lanes and reordering', () => {
    const summary = loopConfigChangeSummary(base, {
      ...base,
      stages: ['doing', 'todo', 'done'],
      stageConfig: [{ stage: 'doing', runner: 'desktop' }],
      budgetCreditsPerDay: undefined,
      maxConcurrent: 2,
    });
    expect(summary).toBe('stages reordered; stage config changed for "doing"; budget 200 -> none; lanes 1 -> 2');
  });

  it('keeps the reason ASCII', () => {
    expect(loopConfigChangeSummary(base, { ...base, model: 'mod\u00e8le' })).toBe('model model-a -> mod?le');
  });
});
