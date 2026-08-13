import { describe, it, expect } from 'vitest';
import { OWNER_ONLY_FUNCTION_CALL_FIELDS, redactFunctionCallsForViewer } from './promptMetaRedaction';

describe('redactFunctionCallsForViewer', () => {
  const base = [
    { name: 'web_search', parameters: { query: 'weather' }, id: 'call_1', returnValue: 'SECRET RESULT', success: true },
    { name: 'web_fetch', parameters: {}, id: 'call_2', error: 'SECRET ERROR', success: false },
  ];

  it('strips returnValue and error from every entry', () => {
    const out = redactFunctionCallsForViewer(base);
    expect(out).toBeDefined();
    for (const fc of out!) {
      expect(fc).not.toHaveProperty('returnValue');
      expect(fc).not.toHaveProperty('error');
    }
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('preserves name, parameters, id, and success', () => {
    const out = redactFunctionCallsForViewer(base);
    expect(out).toEqual([
      { name: 'web_search', parameters: { query: 'weather' }, id: 'call_1', success: true },
      { name: 'web_fetch', parameters: {}, id: 'call_2', success: false },
    ]);
  });

  it('does NOT mutate the input', () => {
    const input = [{ ...base[0] }];
    redactFunctionCallsForViewer(input);
    expect(input[0].returnValue).toBe('SECRET RESULT');
  });

  it('passes null/undefined through unchanged', () => {
    expect(redactFunctionCallsForViewer(null)).toBeNull();
    expect(redactFunctionCallsForViewer(undefined)).toBeUndefined();
  });

  it('is a no-op (besides copy) when neither field is present', () => {
    const noSecrets = [{ name: 'web_search', parameters: {}, id: 'call_1', success: true }];
    expect(redactFunctionCallsForViewer(noSecrets)).toEqual(noSecrets);
  });

  it('returns an empty array unchanged', () => {
    expect(redactFunctionCallsForViewer([])).toEqual([]);
  });

  it('keeps OWNER_ONLY_FUNCTION_CALL_FIELDS as the single source of truth', () => {
    expect(OWNER_ONLY_FUNCTION_CALL_FIELDS).toContain('returnValue');
    expect(OWNER_ONLY_FUNCTION_CALL_FIELDS).toContain('error');
  });
});
