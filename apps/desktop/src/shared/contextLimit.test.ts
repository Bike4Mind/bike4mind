import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './chat';
import {
  autoCompactThreshold,
  CONTEXT_CAP_TOKENS,
  effectiveContextLimit,
  estimateTextTokens,
  occupiedTokens,
  resentReplyTokens,
  shouldAutoCompact,
} from './contextLimit';

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

  it('counts what the next request re-sends of the last reply when asked', () => {
    const threshold = autoCompactThreshold(16_384);
    const answered: ChatMessage = {
      ...reply('b'),
      content: 'x'.repeat(2400),
      usage: { inputTokens: threshold - 500, outputTokens: 600 },
    };
    expect(shouldAutoCompact([typed('a'), answered], 16_384)).toBe(false);
    expect(shouldAutoCompact([typed('a'), answered], 16_384, true)).toBe(true);
  });

  it('does not count reasoning, which is never sent back', () => {
    const threshold = autoCompactThreshold(16_384);
    const thought: ChatMessage = {
      ...reply('b'),
      content: '391',
      usage: { inputTokens: threshold - 500, outputTokens: 1262 },
    };
    expect(shouldAutoCompact([typed('a'), thought], 16_384, true)).toBe(false);
  });

  it('does nothing for a conversation that has measured nothing', () => {
    expect(shouldAutoCompact([], 1_050_000)).toBe(false);
    expect(shouldAutoCompact([typed('a')], 1_050_000)).toBe(false);
  });
});

describe('occupiedTokens', () => {
  it('is the figure auto-compaction decides on, so the ring turns red exactly when it fires', () => {
    const threshold = autoCompactThreshold(8192);
    const calls = [{ id: 'c1', name: 'read_file', input: { path: 'a.ts' }, status: 'done' as const }];
    const answered: ChatMessage = {
      ...reply('b'),
      content: 'done',
      toolCalls: calls,
      rounds: [
        { text: 'looking', toolCallIds: ['c1'], usage: { inputTokens: 5000 } },
        { text: 'x'.repeat(400), toolCallIds: [], usage: { inputTokens: threshold - 100 } },
      ],
    };
    const messages = [typed('a'), answered];
    expect(resentReplyTokens(answered)).toBe(100);
    expect(occupiedTokens(messages, false, true)).toBe(threshold);
    expect(shouldAutoCompact(messages, 8192, true)).toBe(true);
    expect(occupiedTokens(messages, false, false)).toBe(threshold - 100);
  });
});

describe('resentReplyTokens', () => {
  const read = { id: 'c1', name: 'read_file', input: { path: 'a.ts' }, status: 'done' as const };
  const callTokens = Math.ceil(('read_file' + JSON.stringify({ path: 'a.ts' })).length / 4);

  it('counts the results of a last round that ran tools, which no measured request carried', () => {
    const stopped: ChatMessage = {
      ...reply('b'),
      content: 'Reading.',
      stopReason: 'tool_turn_limit',
      toolCalls: [{ ...read, preview: 'x'.repeat(24_000) }],
      rounds: [{ text: 'Reading.', toolCallIds: ['c1'], usage: { inputTokens: 11_000 } }],
    };
    expect(resentReplyTokens(stopped)).toBe(2 + callTokens + 6000);
  });

  it('leaves out results an answered round already re-sent', () => {
    const answered: ChatMessage = {
      ...reply('b'),
      content: 'Done.',
      toolCalls: [{ ...read, preview: 'x'.repeat(24_000) }],
      rounds: [
        { text: 'Reading.', toolCallIds: ['c1'], usage: { inputTokens: 5000 } },
        { text: 'Done.', toolCallIds: [], usage: { inputTokens: 11_000 } },
      ],
    };
    expect(resentReplyTokens(answered)).toBe(2);
  });

  it('counts every round after the measured one, with the measured round own calls and results', () => {
    const stopped: ChatMessage = {
      ...reply('b'),
      content: 'Reading.\n\nPartial',
      stopReason: 'aborted',
      toolCalls: [{ ...read, preview: 'x'.repeat(24_000) }],
      rounds: [
        { text: 'Reading.', toolCallIds: ['c1'], usage: { inputTokens: 9000 } },
        { text: 'Partial', toolCallIds: [] },
      ],
    };
    expect(resentReplyTokens(stopped)).toBe(2 + callTokens + 6000 + 2);
  });

  it('counts an artifact the wire puts back, and CJK at a token a character', () => {
    const page: ChatMessage = {
      ...reply('b'),
      content: 'Here.',
      artifacts: [{ id: 'a1', type: 'html', mimeType: 'text/html', title: 'Page', content: 'x'.repeat(36_000) }],
    };
    expect(resentReplyTokens(page)).toBeGreaterThan(9000);
    expect(resentReplyTokens({ ...reply('b'), content: String.fromCharCode(0x4e2d).repeat(1000) })).toBe(1000);
  });
});

describe('estimateTextTokens', () => {
  it('counts Latin text at four characters a token and wide characters at one', () => {
    expect(estimateTextTokens('x'.repeat(400))).toBe(100);
    expect(estimateTextTokens(String.fromCharCode(0x4eca, 0x5929).repeat(50) + 'x'.repeat(40))).toBe(110);
    expect(estimateTextTokens(String.fromCharCode(0xac00, 0x3042, 0xff01))).toBe(3);
  });

  it('weighs each script by code point, astral characters included', () => {
    expect(estimateTextTokens(String.fromCodePoint(0x0915, 0x093e, 0x0e01, 0x0e32).repeat(100))).toBe(450);
    expect(estimateTextTokens(String.fromCodePoint(0x20000, 0x2a6d6, 0x1f600, 0x1f680).repeat(200))).toBe(1400);
    expect(estimateTextTokens(String.fromCodePoint(0x043f, 0x0440, 0x0438, 0x0432, 0x0435, 0x0442).repeat(50))).toBe(
      120
    );
    expect(estimateTextTokens(`caf${String.fromCodePoint(0xe9)} na${String.fromCodePoint(0xef)}ve`)).toBe(3);
  });
});
