import { describe, it, expect } from 'vitest';
import { classifyStage } from './FeedbackTypes';

describe('classifyStage', () => {
  it('classifies production as production', () => {
    expect(classifyStage('production')).toBe('production');
  });

  it('classifies every other stage as nonprod', () => {
    expect(classifyStage('staging')).toBe('nonprod');
    expect(classifyStage('dev')).toBe('nonprod');
    expect(classifyStage('some-preview-stage')).toBe('nonprod');
  });

  it('classifies undefined as nonprod', () => {
    expect(classifyStage(undefined)).toBe('nonprod');
  });
});
