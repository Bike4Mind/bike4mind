import { describe, it, expect } from 'vitest';
import { buildLoopQuery, LOOP_MEMORY_TAIL_CHARS, parseLoopMemory } from './loopMemory';

const previous = { notes: 'old notes', nextAction: 'old next' };
const block = (json: string) => '```loop-memory\n' + json + '\n```';

describe('parseLoopMemory', () => {
  it('reads a valid block', () => {
    const answer = `Done.\n\n${block('{"notes":"n1","nextAction":"a1"}')}`;
    expect(parseLoopMemory(answer, previous)).toEqual({ notes: 'n1', nextAction: 'a1' });
  });

  it('takes the last of several blocks', () => {
    const answer = `${block('{"notes":"first","nextAction":"x"}')}\nmore\n${block('{"notes":"last","nextAction":"y"}')}`;
    expect(parseLoopMemory(answer, previous)).toEqual({ notes: 'last', nextAction: 'y' });
  });

  it('falls back to the answer tail and keeps the previous nextAction when the block is absent', () => {
    expect(parseLoopMemory('just an answer', previous)).toEqual({ notes: 'just an answer', nextAction: 'old next' });
  });

  it('falls back when the block is malformed or has the wrong shape', () => {
    expect(parseLoopMemory(block('{not json'), previous).nextAction).toBe('old next');
    expect(parseLoopMemory(block('{"notes":1,"nextAction":"a"}'), previous).nextAction).toBe('old next');
  });

  it('caps the fallback notes to the answer tail', () => {
    const answer = 'a'.repeat(LOOP_MEMORY_TAIL_CHARS) + 'TAIL';
    const { notes } = parseLoopMemory(answer, previous);
    expect(notes).toHaveLength(LOOP_MEMORY_TAIL_CHARS);
    expect(notes.endsWith('TAIL')).toBe(true);
  });
});

describe('buildLoopQuery', () => {
  it('carries the goal, the memory and the write-back instruction', () => {
    const context = buildLoopQuery('Watch the inbox', { notes: 'saw 3 issues', nextAction: 'triage #2' });
    expect(context.startsWith('Watch the inbox')).toBe(true);
    expect(context).toContain('saw 3 issues');
    expect(context).toContain('triage #2');
    expect(context).toContain('```loop-memory');
  });
});
