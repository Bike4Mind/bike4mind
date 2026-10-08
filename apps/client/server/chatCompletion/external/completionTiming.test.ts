import { describe, expect, it } from 'vitest';
import { classifyChunk, createCompletionTiming } from './completionTiming';

describe('classifyChunk', () => {
  it('tells an empty thinking marker from readable reasoning', () => {
    expect(classifyChunk(['<think>'], { channel: 'reasoning' })).toBe('reasoningMarker');
    expect(classifyChunk(['', '</think>'], { channel: 'reasoning' })).toBe('reasoningMarker');
    expect(classifyChunk(['Comparing the two trains'], { channel: 'reasoning' })).toBe('reasoning');
  });

  it('reads a tool call off toolsUsed whatever the text says', () => {
    expect(classifyChunk(['done'], { toolsUsed: [{ name: 'file_write', arguments: '{}' }] })).toBe('toolUse');
  });

  it('separates visible text from a usage-only frame', () => {
    expect(classifyChunk(['', 'Hello'])).toBe('text');
    expect(classifyChunk([], { outputTokens: 3 })).toBe('usageOnly');
  });
});

describe('createCompletionTiming', () => {
  it('marks phases and first chunks once, relative to receipt', () => {
    let clock = 1000;
    const timing = createCompletionTiming(() => clock);
    clock = 1010;
    timing.phase('authed');
    clock = 1020;
    timing.phase('completionStarted');
    clock = 1500;
    timing.chunk('reasoningMarker');
    clock = 9500;
    timing.chunk('text');
    clock = 9600;
    timing.chunk('text');

    const summary = timing.summary();
    expect(summary.authed).toBe(10);
    expect(summary.completionStarted).toBe(20);
    expect(summary.first_reasoningMarker).toBe(500);
    expect(summary.first_text).toBe(8500);
    expect(summary.chunks).toBe(3);
    expect(summary.endMs).toBe(8600);
  });

  it('reports the longest silence and what ended it, counting the wait for the first chunk', () => {
    let clock = 0;
    const timing = createCompletionTiming(() => clock);
    timing.phase('completionStarted');
    clock = 30_000;
    timing.chunk('toolUse');

    expect(timing.summary()).toMatchObject({ maxGapMs: 30_000, maxGapBefore: 'toolUse' });
  });
});
