import { describe, it, expect, vi } from 'vitest';
import { attachFullToolResult } from '@bike4mind/llm-adapters';
import { diagnoseAnswer } from '@bike4mind/common';
import { toolsUsedToFunctionCalls } from './toolsUsedToFunctionCalls';

describe('toolsUsedToFunctionCalls', () => {
  it('maps name, parsed parameters, and id', () => {
    const result = toolsUsedToFunctionCalls([{ name: 'web_search', arguments: '{"query":"weather"}', id: 'call_1' }]);
    expect(result).toEqual([
      {
        name: 'web_search',
        parameters: { query: 'weather' },
        id: 'call_1',
        returnValue: undefined,
        success: undefined,
      },
    ]);
  });

  it('carries returnValue and success through the mapping', () => {
    const result = toolsUsedToFunctionCalls([
      { name: 'web_search', arguments: '{}', id: 'call_1', returnValue: '5 results found', success: true },
    ]);
    expect(result[0].returnValue).toBe('5 results found');
    expect(result[0].success).toBe(true);
  });

  it('defaults to empty parameters when arguments are absent', () => {
    const result = toolsUsedToFunctionCalls([{ name: 'no_args_tool' }]);
    expect(result[0].parameters).toEqual({});
  });

  it('falls back to empty parameters and calls onParseError on malformed JSON (#9328 guard)', () => {
    const onParseError = vi.fn();
    const result = toolsUsedToFunctionCalls(
      [{ name: 'broken_tool', arguments: '{not json', id: 'call_1' }],
      onParseError
    );
    expect(result[0].parameters).toEqual({});
    expect(onParseError).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'broken_tool', argumentsPreview: '{not json' })
    );
  });

  it('does not call onParseError when arguments parse cleanly', () => {
    const onParseError = vi.fn();
    toolsUsedToFunctionCalls([{ name: 'web_search', arguments: '{}' }], onParseError);
    expect(onParseError).not.toHaveBeenCalled();
  });

  it('returns an empty array for an empty input', () => {
    expect(toolsUsedToFunctionCalls([])).toEqual([]);
  });

  it('carries executionTime through on both a successful and a failed call', () => {
    const result = toolsUsedToFunctionCalls([
      { name: 'web_search', arguments: '{}', id: 'call_1', returnValue: 'ok', success: true, executionTime: 842 },
      {
        name: 'web_search',
        arguments: '{}',
        id: 'call_2',
        returnValue: 'Error: timed out',
        success: false,
        executionTime: 20_500,
      },
    ]);
    expect(result[0].executionTime).toBe(842);
    expect(result[1].executionTime).toBe(20_500);
  });

  it('leaves executionTime undefined when the source entry has none', () => {
    const result = toolsUsedToFunctionCalls([{ name: 'web_search', arguments: '{}', id: 'call_1' }]);
    expect(result[0].executionTime).toBeUndefined();
  });

  it('never carries the in-memory full result onto functionCalls', () => {
    const entry = { name: 'web_fetch', arguments: '{}', id: 'call_1', returnValue: 'short' };
    attachFullToolResult(entry, 'short and long');
    const result = toolsUsedToFunctionCalls([entry]);
    expect(JSON.stringify(result)).not.toContain('short and long');
    expect(result[0].returnValue).toBe('short');
  });

  it('carries a timed-out call through so Answer Diagnosis names the timeout', () => {
    // Shape BaseBedrockBackend records for a thrown tool error (base.toolFailureRecorded.test.ts).
    const functionCalls = toolsUsedToFunctionCalls([
      {
        name: 'web_search',
        arguments: '{"query":"bikes"}',
        id: 'call_1',
        success: false,
        returnValue:
          'Error processing web_search tool: Web search timed out: SerpAPI did not respond within 10s (tried 2 times)',
      },
    ]);
    const tools = diagnoseAnswer({ functionCalls }).checks.find(c => c.id === 'tools')!;
    expect(tools.status).toBe('fail');
    expect(tools.detail).toContain('timed out (web_search): Web search timed out: SerpAPI did not respond');
  });
});
