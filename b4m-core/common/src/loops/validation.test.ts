import { describe, it, expect } from 'vitest';
import { STAGE_SKILLS_MAX, validateLoopStageConfig } from './validation';

const stages = ['todo', 'doing', 'done'];

describe('validateLoopStageConfig agentId and skills', () => {
  it('keeps agentId and skills, and drops empty values', () => {
    expect(validateLoopStageConfig([{ stage: 'todo', agentId: ' a1 ', skills: ['s1', 's1', 's2'] }], stages)).toEqual([
      { stage: 'todo', agentId: 'a1', skills: ['s1', 's2'] },
    ]);
    expect(validateLoopStageConfig([{ stage: 'todo', agentId: '', skills: [] }], stages)).toEqual([]);
    expect(validateLoopStageConfig([{ stage: 'todo', agentId: null, skills: null, model: 'm' }], stages)).toEqual([
      { stage: 'todo', model: 'm' },
    ]);
  });

  it.each([
    [{ stage: 'todo', agentId: 5 }, /agentId must be a string/],
    [{ stage: 'todo', skills: 's1' }, /skills must be an array/],
    [{ stage: 'todo', skills: [5] }, /skills entry/],
    [{ stage: 'todo', skills: Array.from({ length: STAGE_SKILLS_MAX + 1 }, (_, i) => `s${i}`) }, /entries or fewer/],
    [{ stage: 'todo', agentId: 'a'.repeat(201) }, /agentId must be 200 characters or fewer/],
  ])('rejects an invalid entry (%#)', (entry, message) => {
    expect(() => validateLoopStageConfig([entry], stages)).toThrow(message);
  });

  it('rejects agentId on a desktop stage but allows skills there', () => {
    expect(() => validateLoopStageConfig([{ stage: 'todo', runner: 'desktop', agentId: 'a1' }], stages)).toThrow(
      /only applies to cloud stages/
    );
    expect(validateLoopStageConfig([{ stage: 'todo', runner: 'desktop', skills: ['s1'] }], stages)).toEqual([
      { stage: 'todo', runner: 'desktop', skills: ['s1'] },
    ]);
  });

  it('accepts agentId on a cloud stage, explicit or by default', () => {
    expect(validateLoopStageConfig([{ stage: 'doing', runner: 'cloud', agentId: 'a1' }], stages)).toEqual([
      { stage: 'doing', runner: 'cloud', agentId: 'a1' },
    ]);
  });
});
