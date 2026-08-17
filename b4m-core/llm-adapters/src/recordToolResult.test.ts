import { describe, it, expect } from 'vitest';
import {
  recordToolResult,
  truncateToolResult,
  MAX_RECORDED_TOOL_RESULT_CHARS,
  TOOL_RESULT_TRUNCATION_NOTICE,
  type RecordableToolUse,
} from './recordToolResult';

describe('truncateToolResult', () => {
  it('leaves a result at or under the cap untouched', () => {
    const atCap = 'x'.repeat(MAX_RECORDED_TOOL_RESULT_CHARS);
    expect(truncateToolResult(atCap)).toBe(atCap);
    expect(truncateToolResult('short')).toBe('short');
  });

  it('truncates and appends the notice when over the cap', () => {
    const overCap = 'x'.repeat(MAX_RECORDED_TOOL_RESULT_CHARS + 1);
    const result = truncateToolResult(overCap);
    expect(result).toBe('x'.repeat(MAX_RECORDED_TOOL_RESULT_CHARS) + TOOL_RESULT_TRUNCATION_NOTICE);
    expect(result.length).toBe(MAX_RECORDED_TOOL_RESULT_CHARS + TOOL_RESULT_TRUNCATION_NOTICE.length);
  });
});

describe('recordToolResult', () => {
  it('attaches returnValue and success to the matching entry by id', () => {
    const toolsUsed: RecordableToolUse[] = [{ name: 'web_search', id: 'call_1' }];
    recordToolResult(toolsUsed, { id: 'call_1', name: 'web_search' }, '5 results found', true);
    expect(toolsUsed[0].returnValue).toBe('5 results found');
    expect(toolsUsed[0].success).toBe(true);
  });

  it('records a failure with success:false and the error text as returnValue', () => {
    const toolsUsed: RecordableToolUse[] = [{ name: 'web_fetch', id: 'call_1' }];
    recordToolResult(toolsUsed, { id: 'call_1', name: 'web_fetch' }, 'Error processing web_fetch tool: timeout', false);
    expect(toolsUsed[0].success).toBe(false);
    expect(toolsUsed[0].returnValue).toContain('timeout');
  });

  it('falls back to matching by name when no id is provided', () => {
    const toolsUsed: RecordableToolUse[] = [{ name: 'web_search' }];
    recordToolResult(toolsUsed, { name: 'web_search' }, 'result', true);
    expect(toolsUsed[0].returnValue).toBe('result');
    expect(toolsUsed[0].success).toBe(true);
  });

  it('gives two same-name calls in one turn distinct results (id-first correlation)', () => {
    const toolsUsed: RecordableToolUse[] = [
      { name: 'web_search', id: 'call_1' },
      { name: 'web_search', id: 'call_2' },
    ];
    recordToolResult(toolsUsed, { id: 'call_2', name: 'web_search' }, 'second', true);
    recordToolResult(toolsUsed, { id: 'call_1', name: 'web_search' }, 'first', true);
    expect(toolsUsed[0].returnValue).toBe('first');
    expect(toolsUsed[1].returnValue).toBe('second');
  });

  it('does not overwrite an already-stamped entry from an earlier turn', () => {
    const toolsUsed: RecordableToolUse[] = [
      { name: 'web_search', id: 'call_1', returnValue: 'first turn', success: true },
    ];
    recordToolResult(toolsUsed, { id: 'call_2', name: 'web_search' }, 'second turn', true);
    expect(toolsUsed[0].returnValue).toBe('first turn');
    expect(toolsUsed).toHaveLength(1);
  });

  it('is a silent no-op when neither id nor name matches anything', () => {
    const toolsUsed: RecordableToolUse[] = [{ name: 'web_search', id: 'call_1' }];
    expect(() => recordToolResult(toolsUsed, { id: 'call_9', name: 'other_tool' }, 'result', true)).not.toThrow();
    expect(toolsUsed[0].returnValue).toBeUndefined();
  });

  // Isolates the id-mismatch case a real mis-wiring would actually produce: a backend that
  // passes the WRONG id field but the RIGHT name. The case above varies both id and name at
  // once, which can't tell "id lookup is correct" from "nothing matched at all".
  it('is a silent no-op when the id does not match, even though the name does', () => {
    const toolsUsed: RecordableToolUse[] = [{ name: 'web_search', id: 'call_1' }];
    expect(() => recordToolResult(toolsUsed, { id: 'call_9', name: 'web_search' }, 'result', true)).not.toThrow();
    expect(toolsUsed[0].returnValue).toBeUndefined();
  });

  it('truncates a long observation before attaching it', () => {
    const toolsUsed: RecordableToolUse[] = [{ name: 'web_search', id: 'call_1' }];
    const longResult = 'x'.repeat(MAX_RECORDED_TOOL_RESULT_CHARS + 500);
    recordToolResult(toolsUsed, { id: 'call_1', name: 'web_search' }, longResult, true);
    expect(toolsUsed[0].returnValue?.length).toBe(
      MAX_RECORDED_TOOL_RESULT_CHARS + TOOL_RESULT_TRUNCATION_NOTICE.length
    );
  });
});
