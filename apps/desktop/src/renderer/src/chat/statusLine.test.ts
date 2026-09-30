import { describe, expect, it } from 'vitest';
import type { ChatToolCall, ChatToolStatus } from '@shared/chat';
import {
  describeActivity,
  describeSplit,
  formatCost,
  formatElapsed,
  formatTokens,
  statusFields,
  totalTokens,
} from './statusLine';

function call(name: string, status: ChatToolStatus, progress?: string): ChatToolCall {
  return { id: name, name, input: {}, status, ...(progress ? { progress } : {}) };
}

describe('formatElapsed', () => {
  it('counts seconds, then minutes, then hours', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(187_000)).toBe('3m 7s');
    expect(formatElapsed(3_840_000)).toBe('1h 4m');
  });
});

describe('formatTokens', () => {
  it('stays exact below a thousand and gets compact above it', () => {
    expect(formatTokens(820)).toBe('820');
    expect(formatTokens(1100)).toBe('1.1k');
    expect(formatTokens(12_300)).toBe('12k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });
});

describe('totalTokens', () => {
  it('sums what the server reported', () => {
    expect(totalTokens({ inputTokens: 900, outputTokens: 200 })).toBe(1100);
    expect(totalTokens({ inputTokens: 900 })).toBe(900);
  });

  it('is null when the server reported nothing, which is not zero', () => {
    expect(totalTokens(undefined)).toBeNull();
    expect(totalTokens({})).toBeNull();
    expect(totalTokens({ inputTokens: 0, outputTokens: 0 })).toBeNull();
  });
});

describe('totalTokens with caching', () => {
  it('counts new input, cache writes and output but not cache reads', () => {
    expect(
      totalTokens({ inputTokens: 100, cacheReadInputTokens: 5000, cacheCreationInputTokens: 400, outputTokens: 50 })
    ).toBe(550);
  });

  it('is null for a request that was only cache reads', () => {
    expect(totalTokens({ cacheReadInputTokens: 900 })).toBeNull();
  });
});

describe('formatCost', () => {
  it('prefers the server dollar figure and falls back to credits', () => {
    expect(formatCost({ usdCost: 3.2 })).toBe('$3.20');
    expect(formatCost({ usdCost: 0.004 })).toBe('$0.0040');
    expect(formatCost({ creditsUsed: 1234.4 })).toBe('1,234 credits');
    expect(formatCost({ usdCost: 1, creditsUsed: 9 })).toBe('$1.00');
  });

  it('is null when the server sent no cost', () => {
    expect(formatCost(undefined)).toBeNull();
    expect(formatCost({ inputTokens: 5 })).toBeNull();
  });
});

describe('describeSplit', () => {
  it('lists the four parts compactly and skips what was not reported', () => {
    expect(
      describeSplit({
        inputTokens: 12_000,
        cacheReadInputTokens: 1_100_000,
        cacheCreationInputTokens: 40_000,
        outputTokens: 3200,
      })
    ).toBe('12k new input, 1.1M cached, 40k cache write, 3.2k output');
    expect(describeSplit({ inputTokens: 300, outputTokens: 20 })).toBe('300 new input, 20 output');
    expect(describeSplit(undefined)).toBeNull();
    expect(describeSplit({})).toBeNull();
  });
});

describe('statusFields with usage', () => {
  it('shows the total without cache reads, and the cost, when there is one', () => {
    const usage = { inputTokens: 100, cacheReadInputTokens: 5000, outputTokens: 50, usdCost: 0.5 };
    expect(statusFields({ startedAt: 0, tokens: totalTokens(usage), usage }, 12_000, 'Thinking...')).toEqual([
      '12s',
      '150 tokens',
      '$0.50',
      'Thinking...',
    ]);
  });

  it('still lists the cached reads in the tooltip split', () => {
    expect(describeSplit({ inputTokens: 100, cacheReadInputTokens: 5000, outputTokens: 50 })).toContain('5.0k cached');
  });

  it('omits the cost when the server sent none', () => {
    const usage = { inputTokens: 100, outputTokens: 50 };
    expect(statusFields({ startedAt: 0, tokens: 150, usage }, 0, 'x')).toEqual(['0s', '150 tokens', 'x']);
  });
});

describe('describeActivity', () => {
  it('names code being written instead of calling it responding', () => {
    expect(describeActivity([], true, { kind: 'artifact', title: 'Dashboard' })).toBe(
      'Creating an artifact: Dashboard...'
    );
    expect(describeActivity([], true, { kind: 'code' })).toBe('Writing code...');
  });

  it('still lets a running tool or an approval outrank code being written', () => {
    expect(describeActivity([call('file_read', 'running')], true, { kind: 'code' })).not.toBe('Writing code...');
    expect(describeActivity([call('file_write', 'awaiting-approval')], true, { kind: 'code' })).toBe(
      'Waiting for your answer...'
    );
  });

  it('puts a blocked approval ahead of everything else', () => {
    expect(describeActivity([call('bash_execute', 'awaiting-approval'), call('file_read', 'running')], false)).toBe(
      'Waiting for your answer...'
    );
  });

  it('names the one tool being waited on', () => {
    expect(describeActivity([call('file_read', 'running')], false)).toBe('Reading files...');
  });

  it('prefers the progress line a running tool reports to the generic phrase', () => {
    expect(describeActivity([call('generate_image', 'running', 'rendering, 40%')], false)).toBe('rendering, 40%');
  });

  it('does not try to name several at once', () => {
    expect(describeActivity([call('file_read', 'running'), call('grep_search', 'running')], false)).toBe(
      'Running tools...'
    );
  });

  it('distinguishes a reply being written from one not started', () => {
    expect(describeActivity([call('file_read', 'done')], true)).toBe('Responding...');
    expect(describeActivity([], false)).toBe('Thinking...');
  });
});

describe('statusFields', () => {
  const startedAt = 1_000_000;

  it('leaves the token field out until a real count has arrived', () => {
    expect(statusFields({ startedAt, tokens: null }, startedAt + 5000, 'Thinking...')).toEqual(['5s', 'Thinking...']);
  });

  it('shows elapsed, tokens and activity once it has', () => {
    expect(statusFields({ startedAt, tokens: 1100 }, startedAt + 187_000, 'Running tools...')).toEqual([
      '3m 7s',
      '1.1k tokens',
      'Running tools...',
    ]);
  });
});
