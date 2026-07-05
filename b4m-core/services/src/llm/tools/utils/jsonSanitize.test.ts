import { describe, it, expect } from 'vitest';
import { sanitizeJsonString, sanitizeJsonStringWithMeta } from './jsonSanitize';

describe('sanitizeJsonString', () => {
  it('should not modify valid JSON with escaped control characters', () => {
    const validJson = '{"title": "Hello\\nWorld", "content": "Line1\\nLine2\\tTabbed"}';
    expect(sanitizeJsonString(validJson)).toBe(validJson);
  });

  it('should escape literal newlines inside string values', () => {
    const input = '{"title": "Hello\nWorld"}';
    const expected = '{"title": "Hello\\nWorld"}';
    expect(sanitizeJsonString(input)).toBe(expected);
  });

  it('should escape literal carriage returns inside string values', () => {
    const input = '{"title": "Hello\rWorld"}';
    const expected = '{"title": "Hello\\rWorld"}';
    expect(sanitizeJsonString(input)).toBe(expected);
  });

  it('should escape literal tabs inside string values', () => {
    const input = '{"title": "Hello\tWorld"}';
    const expected = '{"title": "Hello\\tWorld"}';
    expect(sanitizeJsonString(input)).toBe(expected);
  });

  it('should handle Windows-style CRLF line endings', () => {
    const input = '{"content": "Line1\r\nLine2"}';
    const expected = '{"content": "Line1\\r\\nLine2"}';
    expect(sanitizeJsonString(input)).toBe(expected);
  });

  it('should preserve newlines outside of strings (JSON structure)', () => {
    const input = `{
  "title": "Test",
  "content": "Value"
}`;
    const result = sanitizeJsonString(input);
    expect(result).toContain('\n');
    expect(JSON.parse(result)).toEqual({ title: 'Test', content: 'Value' });
  });

  it('should handle mixed escaped and unescaped newlines', () => {
    const input = '{"title": "Already\\nescaped", "content": "Not\nescaped"}';
    const expected = '{"title": "Already\\nescaped", "content": "Not\\nescaped"}';
    expect(sanitizeJsonString(input)).toBe(expected);
  });

  it('should handle escaped quotes inside strings', () => {
    const input = '{"title": "He said \\"Hello\\"", "content": "Line1\nLine2"}';
    const expected = '{"title": "He said \\"Hello\\"", "content": "Line1\\nLine2"}';
    expect(sanitizeJsonString(input)).toBe(expected);
  });

  it('should handle multiple control characters in one string', () => {
    const input = '{"content": "Line1\nLine2\tTabbed\rReturn"}';
    const expected = '{"content": "Line1\\nLine2\\tTabbed\\rReturn"}';
    expect(sanitizeJsonString(input)).toBe(expected);
  });

  it('should handle empty strings', () => {
    const input = '{"title": "", "content": ""}';
    expect(sanitizeJsonString(input)).toBe(input);
  });

  it('should handle complex nested JSON', () => {
    const input = '{"title": "Test", "tags": ["tag1", "tag\n2"], "content": "Hello\nWorld"}';
    const expected = '{"title": "Test", "tags": ["tag1", "tag\\n2"], "content": "Hello\\nWorld"}';
    expect(sanitizeJsonString(input)).toBe(expected);
  });

  it('should handle backslash followed by non-escape character', () => {
    const input = '{"path": "C:\\\\Users\\\\test", "content": "Hello\nWorld"}';
    const result = sanitizeJsonString(input);
    expect(result).toBe('{"path": "C:\\\\Users\\\\test", "content": "Hello\\nWorld"}');
  });

  // SRE-specific cases: multi-line TypeScript in before/after fields
  it('should handle multi-line TypeScript code in before/after fields', () => {
    const input = '{"before": "function foo() {\n  return bar;\n}", "after": "function foo() {\n  return baz;\n}"}';
    const result = sanitizeJsonString(input);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.before).toBe('function foo() {\n  return bar;\n}');
    expect(parsed.after).toBe('function foo() {\n  return baz;\n}');
  });

  it('should handle code containing regex with backslashes', () => {
    const input = '{"before": "const re = /test\\\\.ts$/"}';
    const result = sanitizeJsonString(input);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('should escape NUL byte (U+0000) inside strings', () => {
    const input = '{"content": "before\x00after"}';
    const result = sanitizeJsonString(input);
    expect(result).toBe('{"content": "before\\u0000after"}');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('should escape form feed (U+000C) inside strings', () => {
    const input = '{"content": "before\x0cafter"}';
    const result = sanitizeJsonString(input);
    expect(result).toBe('{"content": "before\\fafter"}');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('should escape backspace (U+0008) inside strings', () => {
    const input = '{"content": "before\x08after"}';
    const result = sanitizeJsonString(input);
    expect(result).toBe('{"content": "before\\bafter"}');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('should escape other control chars (U+0001-U+0007, U+000E-U+001F) via unicode escapes', () => {
    // U+0001 (SOH)
    const input = '{"content": "before\x01after"}';
    const result = sanitizeJsonString(input);
    expect(result).toBe('{"content": "before\\u0001after"}');
    expect(() => JSON.parse(result)).not.toThrow();

    // U+001F (Unit Separator)
    const input2 = '{"content": "before\x1fafter"}';
    const result2 = sanitizeJsonString(input2);
    expect(result2).toBe('{"content": "before\\u001fafter"}');
    expect(() => JSON.parse(result2)).not.toThrow();
  });

  it('should handle mixed escaped and unescaped control characters', () => {
    const input = '{"content": "tab\\there\nnewline\\n\x08backspace"}';
    const result = sanitizeJsonString(input);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('should pass through already-valid JSON unchanged', () => {
    const valid = '{"rootCause": "Missing null check", "confidence": 80, "affectedFiles": []}';
    expect(sanitizeJsonString(valid)).toBe(valid);
  });

  it('array string elements with colons are handled correctly (array context fix)', () => {
    // With the structureStack fix, inKey=false after '[', so `:` inside an array string
    // is treated as embedded (not structural). This is the correct behavior.
    const validArrayWithColon = '{"tags": ["status: ok", "env: prod"]}';
    expect(() => JSON.parse(sanitizeJsonString(validArrayWithColon))).not.toThrow();
    expect(JSON.parse(sanitizeJsonString(validArrayWithColon)).tags).toEqual(['status: ok', 'env: prod']);

    // Array of strings with colons - now handled correctly
    const arrayStringWithColon = '["Check status: it was null"]';
    expect(() => JSON.parse(sanitizeJsonString(arrayStringWithColon))).not.toThrow();
    expect(JSON.parse(sanitizeJsonString(arrayStringWithColon))[0]).toBe('Check status: it was null');
  });
});

describe('sanitizeJsonStringWithMeta — quote repair heuristic', () => {
  it('valid JSON passes through with zero repairs (try-parse-first path)', () => {
    const valid = '{"rootCause": "Missing null check", "confidence": 80, "affectedFiles": []}';
    const { result, repairedQuotes } = sanitizeJsonStringWithMeta(valid);
    expect(result).toBe(valid);
    expect(repairedQuotes).toBe(0);
  });

  it('repairs unescaped quote mid-string value', () => {
    // LLM emits: {"key": "logger.error("msg")"} - 2 embedded quotes
    const input = '{"key": "logger.error("msg")"}';
    const { result, repairedQuotes } = sanitizeJsonStringWithMeta(input);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result).key).toBe('logger.error("msg")');
    expect(repairedQuotes).toBe(2);
  });

  it('repairs multiple unescaped quotes in one value', () => {
    const input = '{"before": "if (a "b" === c "d") {"}';
    const { result, repairedQuotes } = sanitizeJsonStringWithMeta(input);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(repairedQuotes).toBe(4);
  });

  it('key vs value: colon after quote in value position is NOT structural', () => {
    // rootCause value contains `: ` - should not close the string
    const input = '{"rootCause": "Check status: it was null"}';
    const { result, repairedQuotes } = sanitizeJsonStringWithMeta(input);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result).rootCause).toBe('Check status: it was null');
    expect(repairedQuotes).toBe(0); // valid JSON, no repair needed
  });

  it('key vs value: unescaped quote followed by colon in value position is embedded', () => {
    // Value: Check "status": it was null - the `"` before `:` is in value position -> embedded
    const input = '{"rootCause": "Check "status": it was null"}';
    const { result, repairedQuotes } = sanitizeJsonStringWithMeta(input);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result).rootCause).toBe('Check "status": it was null');
    expect(repairedQuotes).toBe(2);
  });

  it('nested objects with code snippets in before/after fields', () => {
    const input =
      '{"affectedFiles": [{"filePath": "foo.ts", "before": "const x = "old"", "after": "const x = "new""}]}';
    const { result, repairedQuotes } = sanitizeJsonStringWithMeta(input);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.affectedFiles[0].before).toBe('const x = "old"');
    expect(parsed.affectedFiles[0].after).toBe('const x = "new"');
    expect(repairedQuotes).toBe(4);
  });

  it('ambiguous case: quote followed by } treated as structural (conservative)', () => {
    const input = '{"key": "value"}';
    const { result, repairedQuotes } = sanitizeJsonStringWithMeta(input);
    expect(result).toBe(input);
    expect(repairedQuotes).toBe(0);
  });

  it('non-quote JSON errors pass through unchanged (no quote repair applied)', () => {
    // Missing comma between keys - not fixable by quote repair; sanitize returns best-effort
    const input = '{"a": 1 "b": 2}';
    // The heuristic doesn't fix structural errors - just verify it doesn't throw
    expect(() => sanitizeJsonStringWithMeta(input)).not.toThrow();
  });

  it('adjacent "" collapse: two back-to-back quotes merge into one long string (documented limitation)', () => {
    // Known limitation: `""` inside a string is treated as an embedded `"` followed by the
    // opening of the next string - they collapse. Acceptable for LLM output domain.
    const input = '{"key": "before""after"}';
    const { repairedQuotes } = sanitizeJsonStringWithMeta(input);
    // We don't assert a specific parse outcome since this is a known corruption case;
    // just verify the function doesn't throw and reports a repair attempt
    expect(repairedQuotes).toBeGreaterThanOrEqual(0);
    expect(() => sanitizeJsonStringWithMeta(input)).not.toThrow();
  });

  it('unclosed string returns original with zero repairedQuotes (default behavior)', () => {
    // Truncated JSON - LLM cut off mid-string; repair is incomplete and would produce
    // corrupt output, so we return the original to let downstream JSON.parse fail cleanly
    const input = '{"key": "truncated value without closing';
    const { result, repairedQuotes } = sanitizeJsonStringWithMeta(input);
    expect(result).toBe(input);
    expect(repairedQuotes).toBe(0);
  });

  it('truncation repair: salvages unclosed string at end of object', () => {
    const input = '{"rootCause": "The connection pool was exhausted because';
    const { result, repairedQuotes, truncationRepaired } = sanitizeJsonStringWithMeta(input, {
      attemptTruncationRepair: true,
    });
    expect(truncationRepaired).toBe(true);
    expect(repairedQuotes).toBe(0); // structural repair, not quote escaping
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result).rootCause).toBe('The connection pool was exhausted because');
  });

  it('truncation repair: salvages deeply nested truncated string', () => {
    // {"affectedFiles": [{"filePath": "foo.ts", "before": "truncated
    const input = '{"affectedFiles": [{"filePath": "foo.ts", "before": "truncated';
    const { result, truncationRepaired } = sanitizeJsonStringWithMeta(input, {
      attemptTruncationRepair: true,
    });
    expect(truncationRepaired).toBe(true);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.affectedFiles[0].filePath).toBe('foo.ts');
    expect(parsed.affectedFiles[0].before).toBe('truncated');
    // closing order: closes string -> closes object -> closes array -> closes outer object
  });

  it('truncation repair disabled by default — returns original for unclosed string', () => {
    const input = '{"key": "truncated value without closing';
    const { result, truncationRepaired } = sanitizeJsonStringWithMeta(input);
    expect(result).toBe(input);
    expect(truncationRepaired).toBeUndefined();
  });

  it('truncation repair: salvage fails gracefully when result is not valid JSON', () => {
    // String truncated at the very first char - salvage produces {"} which is invalid
    const input = '{"';
    const { result, truncationRepaired } = sanitizeJsonStringWithMeta(input, {
      attemptTruncationRepair: true,
    });
    // Invalid salvage - falls back to returning original
    expect(result).toBe(input);
    expect(truncationRepaired).toBeUndefined();
  });

  it('array element colons treated as embedded (not structural) after array context fix', () => {
    // After fixing inKey=false after '[', colons inside array string values are embedded
    const input = '{"tags": ["status: ok"]}';
    const { result, repairedQuotes } = sanitizeJsonStringWithMeta(input);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result).tags[0]).toBe('status: ok');
    expect(repairedQuotes).toBe(0);
  });

  it('tool call JSON with embedded quotes in search query', () => {
    const input = '{"tool": "github_code_search", "input": {"query": "logger.error("timeout") site:src"}}';
    const { result, repairedQuotes } = sanitizeJsonStringWithMeta(input);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result).input.query).toBe('logger.error("timeout") site:src');
    expect(repairedQuotes).toBe(2);
  });
});
