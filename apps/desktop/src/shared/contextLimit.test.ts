import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './chat';
import { autoCompactThreshold, CONTEXT_CAP_TOKENS, effectiveContextLimit, shouldAutoCompact } from './contextLimit';

function typed(id: string): ChatMessage {
  return { id, role: 'user', content: 'go on', createdAt: '' };
}

function reply(id: string, measured?: number): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: 'done',
    createdAt: '',
    ...(measured === undefined ? {} : { usage: { inputTokens: 1000, cacheReadInputTokens: measured - 1000 } }),
  };
}

function boundary(id: string): ChatMessage {
  return { id, role: 'user', content: 'summary', createdAt: '', system: true, boundary: { kind: 'compact' } };
}

describe('effectiveContextLimit', () => {
  it('caps a window larger than the cap', () => {
    expect(effectiveContextLimit(1_050_000)).toBe(CONTEXT_CAP_TOKENS);
  });

  it('keeps a window smaller than the cap', () => {
    expect(effectiveContextLimit(200_000)).toBe(200_000);
  });

  it('falls back to the cap when the model states no window', () => {
    expect(effectiveContextLimit(undefined)).toBe(CONTEXT_CAP_TOKENS);
    expect(effectiveContextLimit(null)).toBe(CONTEXT_CAP_TOKENS);
    expect(effectiveContextLimit(0)).toBe(CONTEXT_CAP_TOKENS);
  });
});

describe('shouldAutoCompact', () => {
  it('fires at the threshold under the cap, not at the model window', () => {
    const threshold = autoCompactThreshold(CONTEXT_CAP_TOKENS);
    expect(shouldAutoCompact([typed('a'), reply('b', threshold - 1)], 1_050_000)).toBe(false);
    expect(shouldAutoCompact([typed('a'), reply('b', threshold)], 1_050_000)).toBe(true);
  });

  it('fires below a smaller model window, with headroom left before it', () => {
    const threshold = autoCompactThreshold(200_000);
    expect(threshold).toBeLessThan(200_000);
    expect(shouldAutoCompact([typed('a'), reply('b', threshold)], 200_000)).toBe(true);
    // The same figure is nowhere near the cap on a large window.
    expect(shouldAutoCompact([typed('a'), reply('b', threshold)], 1_050_000)).toBe(false);
  });

  it('does not fire again after a compaction: the boundary leaves nothing measured', () => {
    const over = autoCompactThreshold(CONTEXT_CAP_TOKENS) + 10_000;
    expect(shouldAutoCompact([typed('a'), reply('b', over), boundary('c')], 1_050_000)).toBe(false);
    expect(shouldAutoCompact([typed('a'), reply('b', over), boundary('c'), typed('d')], 1_050_000)).toBe(false);
  });

  it('measures the first reply after the boundary, not the one before it', () => {
    const over = autoCompactThreshold(CONTEXT_CAP_TOKENS) + 10_000;
    const messages = [typed('a'), reply('b', over), boundary('c'), typed('d'), reply('e', 14_000)];
    expect(shouldAutoCompact(messages, 1_050_000)).toBe(false);
  });

  it('reads past a reply that measured nothing to the last one that did', () => {
    const over = autoCompactThreshold(CONTEXT_CAP_TOKENS) + 10_000;
    expect(shouldAutoCompact([typed('a'), reply('b', over), typed('c'), reply('d')], 1_050_000)).toBe(true);
  });

  it('does nothing for a conversation that has measured nothing', () => {
    expect(shouldAutoCompact([], 1_050_000)).toBe(false);
    expect(shouldAutoCompact([typed('a')], 1_050_000)).toBe(false);
  });
});
