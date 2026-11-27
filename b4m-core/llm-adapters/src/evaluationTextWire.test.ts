import { describe, expect, it } from 'vitest';
import { assertEvaluationTextWire, assertEvaluationWireBound } from './evaluationTextWire';

describe('evaluation wire validation', () => {
  it('accepts final text, escaped unicode and function schema expansions', () => {
    expect(() =>
      assertEvaluationTextWire({
        messages: [{ content: 'hello \\u1234' }],
        tools: [{ type: 'function', function: { parameters: { type: 'object' } } }],
      })
    ).not.toThrow();
  });
  it('refuses media and provider-executed tools before admission', () => {
    for (const type of ['input_image', 'input_audio', 'web_search', 'code_interpreter'])
      expect(() => assertEvaluationTextWire({ input: [{ type }] })).toThrow();
  });
  it('bounds serialized escaping, tool definitions and framing rather than character estimates', () => {
    const wire = { messages: [{ content: '\u0001'.repeat(100) }], tools: [{ description: 'x'.repeat(2000) }] };
    expect(() => assertEvaluationWireBound(wire, 2000)).toThrow('conservative');
    expect(() => assertEvaluationWireBound(wire, 10000)).not.toThrow();
  });
});
