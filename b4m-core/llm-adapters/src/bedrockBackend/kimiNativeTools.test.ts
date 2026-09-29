import { describe, expect, it } from 'vitest';
import {
  hasNativeToolMarker,
  nativeToolCallsBegin,
  parseNativeToolSection,
  KimiNativeToolStream,
  SECTION_BEGIN,
  SECTION_END,
} from './kimiNativeTools';

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

  it('completes on a large section of unterminated markers', () => {
    const calls = parseNativeToolSection('<|tool_call_begin|> '.repeat(200_000));
    expect(calls).toEqual([]);
  });

  it('returns every call from a section far past the size the old parse cap allowed', () => {
    const call = (i: number) =>
      `<|tool_call_begin|> functions.tool_${i}:${i} <|tool_call_argument_begin|> {"i":${i}} <|tool_call_end|> `;
    let section = '';
    let count = 0;
    while (section.length < 100_000) section += call(count++);
    const calls = parseNativeToolSection(section);
    expect(calls).toHaveLength(count);
    expect(calls[count - 1]).toEqual({
      id: `functions.tool_${count - 1}:${count - 1}`,
      name: `tool_${count - 1}`,
      index: count - 1,
      arguments: `{"i":${count - 1}}`,
    });
  });
});

describe('parseNativeToolSection - linear scan', () => {
  const CB = '<|tool_call_begin|>';
  const AB = '<|tool_call_argument_begin|>';
  const CE = '<|tool_call_end|>';

  // The regex the scanner replaced, kept as the differential oracle.
  const OLD_RE =
    /<\|tool_call_begin\|>\s*([\s\S]+?)\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/g;
  // Control: lets the id be empty, so it diverges wherever an id-less call swallows the next one.
  const CONTROL_RE =
    /<\|tool_call_begin\|>\s*([\s\S]*?)\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/g;

  const parseWith = (re: RegExp, section: string) => {
    const calls: Array<{ id: string; name: string; index: number; arguments: string }> = [];
    let fallbackIndex = 0;
    for (const m of section.matchAll(re)) {
      const id = m[1].trim();
      const bare = id.startsWith('functions.') ? id.slice('functions.'.length) : id;
      const colon = bare.lastIndexOf(':');
      const parsed = colon >= 0 ? Number.parseInt(bare.slice(colon + 1), 10) : Number.NaN;
      const name = colon >= 0 ? bare.slice(0, colon) : bare;
      const index = colon >= 0 && !Number.isNaN(parsed) ? parsed : fallbackIndex;
      if (name) calls.push({ id, name, index, arguments: m[2].trim() });
      fallbackIndex++;
    }
    return calls;
  };

  function mulberry32(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ALPHABET = [
    CB,
    AB,
    CE,
    SECTION_BEGIN,
    SECTION_END,
    ' ',
    '\n',
    '\t',
    '\r',
    '\u00a0',
    '\ufeff',
    'a',
    'fn:1',
    '{}',
  ];
  const corpus = (() => {
    const rand = mulberry32(2998);
    const cases = [
      // An unterminated first call whose ARG_BEGIN is followed only by a stray one.
      `${CB}  ${AB} x ${CE} tail ${AB}`,
      `${CB}${AB} x ${AB} y ${CE}`,
      `${CB} ${AB} {} ${CE} ${CB} fn:1 ${AB} {} ${CE}`,
    ];
    for (let i = 0; i < 2000; i++) {
      const len = 1 + Math.floor(rand() * 40);
      let s = '';
      for (let j = 0; j < len; j++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      cases.push(s);
    }
    return cases;
  })();

  it('yields exactly what the old regex yielded across a seeded corpus', () => {
    let withCalls = 0;
    for (const input of corpus) {
      const expected = parseWith(OLD_RE, input);
      if (expected.length > 0) withCalls++;
      expect(parseNativeToolSection(input), JSON.stringify(input)).toEqual(expected);
    }
    expect(withCalls).toBeGreaterThan(100);
  });

  it('control: the corpus is sharp enough to catch a near-miss regex', () => {
    expect(
      corpus.some(input => JSON.stringify(parseWith(CONTROL_RE, input)) !== JSON.stringify(parseWith(OLD_RE, input)))
    ).toBe(true);
  });

  // Same sampling as measureGrowth in b4m-core/services/src/__tests__/utils/regexLinearity.ts: the
  // input doubles until a warm run takes 25ms, so the ratio compares samples well above timer, JIT
  // and GC noise, and each size keeps its fastest of five runs. Times are thread CPU ms: on a loaded
  // runner a longer run is likelier to be preempted, which inflates a wall-clock ratio.
  const assertLinearGrowth = (build: (n: number) => string, small: number) => {
    const time = (input: string) => {
      const startedAt = process.threadCpuUsage();
      parseNativeToolSection(input);
      const { user, system } = process.threadCpuUsage(startedAt);
      return (user + system) / 1000;
    };
    let n = small;
    let baselineInput = build(n);
    expect(time(baselineInput)).toBeLessThan(500);
    while (time(baselineInput) < 25 && baselineInput.length < 1_000_000) {
      n *= 2;
      baselineInput = build(n);
      expect(time(baselineInput)).toBeLessThan(500);
    }
    const fastest = (input: string) => Math.min(...Array.from({ length: 5 }, () => time(input)));
    const baselineMs = fastest(baselineInput);
    const doubledMs = fastest(build(n * 2));
    let ratio = doubledMs / Math.max(baselineMs, 5);
    // A cache or heap-size cliff lands in one doubling step; a quadratic scan is 4x on both.
    if (ratio >= 3) ratio = Math.min(ratio, fastest(build(n * 4)) / Math.max(doubledMs, 5));
    expect(ratio).toBeLessThan(3);
  };

  // Sizes start at ~64k chars; the old regex took ~400ms at 256k on the first shape.
  it('stays linear on a run of unterminated call markers', () => {
    assertLinearGrowth(n => `${CB} `.repeat(n), 3_200);
    assertLinearGrowth(n => `${CB} `.repeat(n), 25_600);
  });

  it('stays linear on calls that never close', () => {
    assertLinearGrowth(n => `${CB} x ${AB}`.repeat(n), 1_300);
    assertLinearGrowth(n => `${CB} x ${AB}`.repeat(n), 10_400);
  });

  it('stays linear on a run of argument markers after one call marker', () => {
    assertLinearGrowth(n => CB + AB.repeat(n), 2_300);
    assertLinearGrowth(n => CB + AB.repeat(n), 18_400);
  });
});

describe('nativeToolCallsBegin', () => {
  it('prefers the section wrapper', () => {
    const text = 'thinking <|tool_calls_section_begin|> <|tool_call_begin|> a <|tool_call_end|>';
    expect(nativeToolCallsBegin(text)).toBe(text.indexOf('<|tool_calls_section_begin|>'));
  });

  // hasNativeToolMarker accepts a bare call, so scoping on the wrapper alone left that
  // shape falling through to the whole message - the exact input the parse cap truncates.
  it('falls back to the first bare call marker when there is no wrapper', () => {
    const text = 'thinking at length <|tool_call_begin|> functions.a:0 <|tool_call_end|>';
    expect(nativeToolCallsBegin(text)).toBe(text.indexOf('<|tool_call_begin|>'));
  });

  it('returns -1 when there is no call at all', () => {
    expect(nativeToolCallsBegin('just reasoning')).toBe(-1);
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

  // The class holds back SECTION_BEGIN so a raw token never reaches the user. A bare
  // call carries no wrapper, and used to stream straight through as literal text.
  it('yields a bare call with no section wrapper without leaking its tokens', () => {
    const stream = new KimiNativeToolStream();
    const { text, toolCalls } = stream.push(
      'Let me check. <|tool_call_begin|> functions.get_weather:0 <|tool_call_argument_begin|> {"city": "Paris"} <|tool_call_end|> done'
    );
    expect(text).not.toContain('<|');
    // Text either side of the call is surfaced in the same push, as for a wrapped section.
    expect(text).toBe('Let me check.  done');
    expect(toolCalls).toEqual([
      { id: 'functions.get_weather:0', name: 'get_weather', index: 0, arguments: '{"city": "Paris"}' },
    ]);
    expect(stream.flush()).toBe('');
  });

  it('holds back a bare call marker split across a chunk boundary', () => {
    const stream = new KimiNativeToolStream();
    expect(stream.push('Checking now <|tool_call').text).toBe('Checking now ');
    const { text, toolCalls } = stream.push('_begin|> functions.a:0 <|tool_call_argument_begin|> {} <|tool_call_end|>');
    expect(text).toBe('');
    expect(toolCalls.map(c => c.name)).toEqual(['a']);
  });

  it('flush surfaces a held-back tail that turned out not to be a marker', () => {
    const s = new KimiNativeToolStream();
    const a = s.push('trailing <|');
    expect(a.text).toBe('trailing ');
    expect(s.flush()).toBe('<|');
  });
});
