import { describe, it, expect, vi } from 'vitest';
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
});
