import { describe, expect, it } from 'vitest';
import { hasNativeToolMarker, parseNativeToolSection, KimiNativeToolStream } from './kimiNativeTools';

// Fixtures are reasoning-stripped captures from live moonshot.kimi-k2-thinking (Bedrock).
const TWO_TOOL_SECTION =
  '<|tool_call_begin|> functions.math_evaluate:0 <|tool_call_argument_begin|> {"expression": "12*15"} <|tool_call_end|> ' +
  '<|tool_call_begin|> functions.get_weather:1 <|tool_call_argument_begin|> {"city": "Paris"} <|tool_call_end|>';

describe('parseNativeToolSection', () => {
  it('extracts name, index and args for parallel calls, stripping the functions. prefix', () => {
    expect(parseNativeToolSection(TWO_TOOL_SECTION)).toEqual([
      { id: 'functions.math_evaluate:0', name: 'math_evaluate', index: 0, arguments: '{"expression": "12*15"}' },
      { id: 'functions.get_weather:1', name: 'get_weather', index: 1, arguments: '{"city": "Paris"}' },
    ]);
  });

  it('falls back to positional index when the id carries none', () => {
    const calls = parseNativeToolSection(
      '<|tool_call_begin|> search <|tool_call_argument_begin|> {"q":"x"} <|tool_call_end|>'
    );
    expect(calls).toEqual([{ id: 'search', name: 'search', index: 0, arguments: '{"q":"x"}' }]);
  });
});

describe('hasNativeToolMarker', () => {
  it('detects the section and call markers, ignores plain text', () => {
    expect(hasNativeToolMarker('just reasoning about the answer')).toBe(false);
    expect(hasNativeToolMarker('...<|tool_calls_section_begin|>...')).toBe(true);
    expect(hasNativeToolMarker('...<|tool_call_begin|>...')).toBe(true);
  });
});

describe('KimiNativeToolStream', () => {
  it('surfaces the pre-section reasoning and yields tool calls, never leaking a raw token', () => {
    const s = new KimiNativeToolStream();
    const full =
      'I will call the tools. <|tool_calls_section_begin|> ' + TWO_TOOL_SECTION + ' <|tool_calls_section_end|>';
    const { text, toolCalls } = s.push(full);
    expect(text).toBe('I will call the tools. ');
    expect(text).not.toContain('<|');
    expect(toolCalls.map(c => c.name)).toEqual(['math_evaluate', 'get_weather']);
    expect(toolCalls[1].arguments).toBe('{"city": "Paris"}');
  });

  it('handles a section split across the exact deltas Bedrock streamed', () => {
    // Reasoning-stripped inner text of the three real content deltas, in order.
    const deltas = [
      " I'll compute the math problem and get the weather for Paris for you. <|tool_calls_section_begin|> <|tool_call_begin|> functions.math_evaluate:0 <|tool_call_argument_begin|>",
      ' {"expression": "12*15"} <|tool_call_end|> <|tool_call_begin|> functions.get_weather:1 <|tool_call_argument_begin|> {"city": "Paris',
      '"} <|tool_call_end|> <|tool_calls_section_end|>',
    ];
    const s = new KimiNativeToolStream();
    let text = '';
    const calls = [];
    for (const d of deltas) {
      const r = s.push(d);
      text += r.text;
      calls.push(...r.toolCalls);
    }
    text += s.flush();
    expect(text).toBe(" I'll compute the math problem and get the weather for Paris for you. ");
    expect(text).not.toContain('<|');
    expect(calls.map(c => c.name)).toEqual(['math_evaluate', 'get_weather']);
    expect(calls[0].arguments).toBe('{"expression": "12*15"}');
    expect(calls[1].arguments).toBe('{"city": "Paris"}');
  });

  it('passes ordinary reasoning through unchanged, chunk by chunk', () => {
    const s = new KimiNativeToolStream();
    const a = s.push('The user wants 17 x 24. ');
    const b = s.push('That is 408.');
    expect(a.text + b.text).toBe('The user wants 17 x 24. That is 408.');
    expect(a.toolCalls.length + b.toolCalls.length).toBe(0);
  });

  it('holds back a section-begin marker split across a chunk boundary', () => {
    const s = new KimiNativeToolStream();
    const a = s.push('go <|tool_calls_sec');
    expect(a.text).toBe('go '); // partial marker withheld
    const b = s.push(
      'tion_begin|> <|tool_call_begin|> x <|tool_call_argument_begin|> {} <|tool_call_end|> <|tool_calls_section_end|>'
    );
    expect(b.text).toBe('');
    expect(b.toolCalls).toEqual([{ id: 'x', name: 'x', index: 0, arguments: '{}' }]);
    expect(a.text + b.text).not.toContain('<|');
  });

  it('flush surfaces a held-back tail that turned out not to be a marker', () => {
    const s = new KimiNativeToolStream();
    const a = s.push('trailing <|');
    expect(a.text).toBe('trailing ');
    expect(s.flush()).toBe('<|');
  });
});
