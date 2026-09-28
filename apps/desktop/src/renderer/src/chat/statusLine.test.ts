import { describe, expect, it } from 'vitest';
import type { ChatToolCall, ChatToolStatus } from '@shared/chat';
import { describeActivity, formatElapsed, formatTokens, statusFields, totalTokens } from './statusLine';

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

describe('describeActivity', () => {
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
