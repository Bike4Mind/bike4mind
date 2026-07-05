import { describe, it, expect, vi } from 'vitest';
import { StreamAccumulator, stripThinkingBlocks } from './streamAccumulator';
import type { CompletionInfo } from '@bike4mind/llm-adapters';
import type { StreamEvent, ToolUse } from './streamEvents';

// Event-construction helpers keep the tests readable now that the accumulator
// folds a typed union rather than exposing per-shape methods.
const content = (text: string, extra: Partial<Extract<StreamEvent, { type: 'content' }>> = {}): StreamEvent => ({
  type: 'content',
  text,
  ...extra,
});
const toolUse = (
  text: string,
  tools?: ToolUse[],
  extra: Partial<Extract<StreamEvent, { type: 'tool_use' }>> = {}
): StreamEvent => ({
  type: 'tool_use',
  text,
  ...(tools ? { tools } : {}),
  ...extra,
});

describe('stripThinkingBlocks', () => {
  it('strips a single think block', () => {
    expect(stripThinkingBlocks('<think>reasoning here</think>answer')).toBe('answer');
  });

  it('strips multiple think blocks', () => {
    // Blocks are removed in-place; no separator is inserted
    expect(stripThinkingBlocks('<think>a</think>text<think>b</think>more')).toBe('textmore');
  });

  it('returns the original text when no think blocks are present', () => {
    expect(stripThinkingBlocks('plain text')).toBe('plain text');
  });

  it('returns empty string when content is only a think block', () => {
    expect(stripThinkingBlocks('<think>all thinking</think>')).toBe('');
  });

  it('handles multiline think blocks', () => {
    expect(stripThinkingBlocks('<think>\nline1\nline2\n</think>result')).toBe('result');
  });
});

describe('StreamAccumulator', () => {
  describe('isEmpty', () => {
    it('is empty on construction', () => {
      expect(new StreamAccumulator().isEmpty()).toBe(true);
    });

    it('is not empty after a content event with non-whitespace text', () => {
      const acc = new StreamAccumulator();
      acc.apply(content('hello'));
      expect(acc.isEmpty()).toBe(false);
    });

    it('is empty after a content event with only whitespace', () => {
      const acc = new StreamAccumulator();
      acc.apply(content('   '));
      expect(acc.isEmpty()).toBe(true);
    });

    it('is not empty after a tool_use event with tools', () => {
      const acc = new StreamAccumulator();
      acc.apply(toolUse('', [{ name: 'read_file', arguments: '{}' }]));
      expect(acc.isEmpty()).toBe(false);
    });

    it('counts think-block-only content as non-empty (raw text exists)', () => {
      // isEmpty checks raw text - stripping happens in finalize
      const acc = new StreamAccumulator();
      acc.apply(content('<think>thoughts</think>'));
      expect(acc.isEmpty()).toBe(false);
    });
  });

  describe('error events', () => {
    it('are a no-op (carry no accumulable content)', () => {
      const acc = new StreamAccumulator();
      acc.apply({ type: 'error', message: 'boom' });
      expect(acc.isEmpty()).toBe(true);
      expect(acc.rawText).toBe('');
    });
  });

  describe('accumulatedLength and rawText', () => {
    it('tracks length across multiple content events', () => {
      const acc = new StreamAccumulator();
      acc.apply(content('hello '));
      acc.apply(content('world'));
      expect(acc.accumulatedLength).toBe(11);
      expect(acc.rawText).toBe('hello world');
    });

    it('rawText includes think blocks unstripped', () => {
      const acc = new StreamAccumulator();
      acc.apply(content('<think>reasoning</think>answer'));
      expect(acc.rawText).toBe('<think>reasoning</think>answer');
    });
  });

  describe('finalize — text-only path', () => {
    it('calls callback with stripped text', async () => {
      const acc = new StreamAccumulator();
      acc.apply(content('hello'));
      const callback = vi.fn().mockResolvedValue(undefined);
      await acc.finalize(callback);
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(['hello'], {});
    });

    it('strips think blocks before delivering to callback', async () => {
      const acc = new StreamAccumulator();
      acc.apply(content('<think>internal</think>answer'));
      const callback = vi.fn().mockResolvedValue(undefined);
      await acc.finalize(callback);
      expect(callback).toHaveBeenCalledWith(['answer'], {});
    });

    it('does not call callback when text is only think blocks', async () => {
      const acc = new StreamAccumulator();
      acc.apply(content('<think>all thinking, no output</think>'));
      const callback = vi.fn().mockResolvedValue(undefined);
      await acc.finalize(callback);
      expect(callback).not.toHaveBeenCalled();
    });

    it('does not call callback when accumulator is empty', async () => {
      const acc = new StreamAccumulator();
      const callback = vi.fn().mockResolvedValue(undefined);
      await acc.finalize(callback);
      expect(callback).not.toHaveBeenCalled();
    });

    it('passes usage info to callback', async () => {
      const acc = new StreamAccumulator();
      acc.apply(content('text', { usage: { inputTokens: 10, outputTokens: 20 } }));
      const callback = vi.fn().mockResolvedValue(undefined);
      await acc.finalize(callback);
      expect(callback).toHaveBeenCalledWith(['text'], {
        inputTokens: 10,
        outputTokens: 20,
      });
    });

    it('passes credit info to callback', async () => {
      const acc = new StreamAccumulator();
      acc.apply(content('text', { credits: { used: 5, usdCost: 0.01 } }));
      const callback = vi.fn().mockResolvedValue(undefined);
      await acc.finalize(callback);
      expect(callback).toHaveBeenCalledWith(['text'], {
        creditsUsed: 5,
        usdCost: 0.01,
      });
    });
  });

  describe('finalize — tool-use path', () => {
    it('calls callback with tools and thinking blocks', async () => {
      const acc = new StreamAccumulator();
      const tools = [{ name: 'read_file', arguments: '{"path":"/tmp/test"}', id: 'toolu_1' }];
      const thinking = [{ type: 'thinking', content: 'I should read that file' }];
      acc.apply(toolUse('preamble text', tools, { thinking }));
      const callback = vi.fn().mockResolvedValue(undefined);
      await acc.finalize(callback);

      const [textArg, infoArg] = callback.mock.calls[0] as [(string | null | undefined)[], CompletionInfo];
      expect(textArg).toEqual(['preamble text']);
      expect(infoArg.toolsUsed).toEqual(tools);
      expect(infoArg.thinking).toEqual(thinking);
    });

    it('omits thinking from info when no thinking blocks provided', async () => {
      const acc = new StreamAccumulator();
      acc.apply(toolUse('', [{ name: 'bash', arguments: '{}' }]));
      const callback = vi.fn().mockResolvedValue(undefined);
      await acc.finalize(callback);

      const infoArg = callback.mock.calls[0][1] as CompletionInfo;
      expect(infoArg.thinking).toBeUndefined();
    });

    it('tool path calls callback even when text is empty after stripping', async () => {
      const acc = new StreamAccumulator();
      acc.apply(toolUse('', [{ name: 'bash', arguments: '{}' }]));
      const callback = vi.fn().mockResolvedValue(undefined);
      await acc.finalize(callback);
      expect(callback).toHaveBeenCalledOnce();
    });

    it('accumulates text from multiple content events before a tool_use event', async () => {
      const acc = new StreamAccumulator();
      acc.apply(content('part1 '));
      acc.apply(content('part2 '));
      acc.apply(toolUse('part3', [{ name: 'tool', arguments: '{}' }]));
      const callback = vi.fn().mockResolvedValue(undefined);
      await acc.finalize(callback);

      const [textArg] = callback.mock.calls[0] as [(string | null | undefined)[], CompletionInfo];
      expect(textArg).toEqual(['part1 part2 part3']);
    });
  });

  describe('finalize — last usage wins', () => {
    it('uses the most recent usage info when multiple events carry usage', async () => {
      const acc = new StreamAccumulator();
      acc.apply(content('chunk1', { usage: { inputTokens: 5, outputTokens: 3 } }));
      acc.apply(content('chunk2', { usage: { inputTokens: 10, outputTokens: 8 } }));
      const callback = vi.fn().mockResolvedValue(undefined);
      await acc.finalize(callback);

      const infoArg = callback.mock.calls[0][1] as CompletionInfo;
      expect(infoArg.inputTokens).toBe(10);
      expect(infoArg.outputTokens).toBe(8);
    });
  });
});
