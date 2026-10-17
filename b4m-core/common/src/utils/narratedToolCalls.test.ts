import { describe, expect, it } from 'vitest';
import {
  applyNarratedToolCallStrip,
  stripNarratedToolCalls,
  stripNarratedToolCallsFromReplies,
} from './narratedToolCalls';

const OFFERED = { offeredToolNames: ['web_search', 'get_weather'] };

describe('stripNarratedToolCalls', () => {
  const narratedForms: Array<[string, string]> = [
    ['tool_call JSON', '<tool_call>\n{"name": "web_search", "arguments": {"query": "tides"}}\n</tool_call>'],
    ['tool_call one line', '<tool_call>{"name":"web_search","arguments":{}}</tool_call>'],
    [
      'tool_call function tag',
      '<tool_call>\n<function=web_search>\n<parameter=query>tides</parameter>\n</function>\n</tool_call>',
    ],
    ['tool_use JSON', '<tool_use>\n{"name": "web_search", "input": {"query": "tides"}}\n</tool_use>'],
    [
      'function_calls invoke',
      '<function_calls>\n<invoke name="web_search">\n<parameter name="query">tides</parameter>\n</invoke>\n</function_calls>',
    ],
    ['TOOL_CALLS array', '[TOOL_CALLS][{"name": "web_search", "arguments": {"query": "tides"}}]'],
    ['TOOL_CALLS args form', '[TOOL_CALLS]web_search[ARGS]{"query": "tides"}'],
  ];

  it.each(narratedForms)('hides a narrated %s block and reports the tool it names', (_form, block) => {
    const result = stripNarratedToolCalls(`Let me look that up.\n\n${block}\n`, OFFERED);
    expect(result.text.trim()).toBe('Let me look that up.');
    expect(result.toolNames).toEqual(['web_search']);
  });

  it.each(narratedForms)('hides a narrated %s block while rendering without the offered tool list', (_form, block) => {
    expect(stripNarratedToolCalls(`Let me look that up.\n\n${block}`).text.trim()).toBe('Let me look that up.');
  });

  it('keeps prose that follows a closed block', () => {
    const reply = 'Checking.\n<tool_call>{"name":"web_search","arguments":{}}</tool_call>\nThe tide is high.';
    expect(stripNarratedToolCalls(reply, OFFERED).text).toBe('Checking.\nThe tide is high.');
  });

  it('hides every narrated block in a reply', () => {
    const call = (name: string) => `<tool_call>{"name":"${name}","arguments":{}}</tool_call>`;
    const result = stripNarratedToolCalls(`A\n${call('web_search')}\n${call('get_weather')}\nB`, OFFERED);
    expect(result.text).toBe('A\nB');
    expect(result.toolNames).toEqual(['web_search', 'get_weather']);
  });

  it('only strips at finalize when the block names a tool offered on the turn', () => {
    const reply = 'Here.\n<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>';
    expect(stripNarratedToolCalls(reply, OFFERED)).toEqual({ text: reply, toolNames: [] });
  });

  it('hides a block that is still streaming', () => {
    expect(stripNarratedToolCalls('Let me check.\n<tool_call>\n{"name": "web_se').text).toBe('Let me check.\n');
    expect(stripNarratedToolCalls('Let me check.\n<function_calls>\n<inv').text).toBe('Let me check.\n');
    expect(stripNarratedToolCalls('Let me check.\n[TOOL_CALLS][{"na').text).toBe('Let me check.\n');
  });

  it('hides a partial opener on the last line while it streams', () => {
    expect(stripNarratedToolCalls('Let me check.\n<tool_').text).toBe('Let me check.\n');
  });

  it('never strips an unterminated block at finalize, since the real answer may follow it', () => {
    const unclosed = [
      'Checking.\n<tool_call>\n{"name": "web_search", "arguments": {}}',
      '<function_calls>\n<invoke name="web_search">\nHere is the real answer: the tide is high.',
      '[TOOL_CALLS]web_search[ARGS]{"query": "tides"}\nHere is the real answer.',
      '[TOOL_CALLS][{"name": "web_search", "arguments": {}}]\nHere is the real answer.',
    ];
    for (const reply of unclosed)
      expect(stripNarratedToolCalls(reply, OFFERED)).toEqual({ text: reply, toolNames: [] });
  });

  it('does not hide a partial opener at finalize', () => {
    expect(stripNarratedToolCalls('Answer.\n<f', OFFERED).text).toBe('Answer.\n<f');
  });

  it('leaves a block indented four spaces alone, since markdown renders it as code', () => {
    const reply = 'Example:\n\n    <tool_call>{"name":"web_search","arguments":{}}</tool_call>';
    expect(stripNarratedToolCalls(reply, OFFERED).text).toBe(reply);
    expect(stripNarratedToolCalls(reply).text).toBe(reply);
    expect(stripNarratedToolCalls('A\n   <tool_call>{"name":"web_search"}</tool_call>\nB', OFFERED).text).toBe('A\nB');
  });

  // A quadratic scan here stalls the server's event loop on a hostile or degenerate reply.
  it.each([
    ['unclosed openers', '<tool_call>\n'.repeat(17_000)],
    ['openers before one close', '<tool_call>{\n'.repeat(16_000) + '</tool_call>'],
    ['invoke openers', '<function_calls>\n<invoke name="web_search">\n'.repeat(4_600)],
    ['Mistral markers', '[TOOL_CALLS]web_search[ARGS]\n'.repeat(7_000)],
  ])('stays linear on about 200KB of %s', (_case, reply) => {
    const started = performance.now();
    stripNarratedToolCalls(reply, OFFERED);
    stripNarratedToolCalls(reply);
    expect(performance.now() - started).toBeLessThan(200);
  });

  const untouched: Array<[string, string]> = [
    [
      'a fenced example',
      'Hermes models emit:\n\n```xml\n<tool_call>\n{"name": "web_search", "arguments": {}}\n</tool_call>\n```\n\nThat is the format.',
    ],
    ['inline code', 'Wrap it as `<tool_call>{"name":"web_search"}</tool_call>` and send it.'],
    ['a mid-line mention', 'The model wrote <tool_call>{"name":"web_search"}</tool_call> instead of calling it.'],
    ['a line-start tag with prose inside', '<tool_call> tags are how Qwen marks calls. </tool_call> closes them.'],
    ['a TOOL_CALLS mention', '[TOOL_CALLS] is the Mistral marker for calls.'],
    ['a markdown link', 'See [the docs](https://example.com).'],
  ];

  it.each(untouched)('leaves %s untouched', (_case, reply) => {
    expect(stripNarratedToolCalls(reply, OFFERED)).toEqual({ text: reply, toolNames: [] });
    expect(stripNarratedToolCalls(reply).text).toBe(reply);
  });

  it('leaves a narrated block inside reasoning alone', () => {
    const reply = '<think>\n<tool_call>{"name":"web_search","arguments":{}}</tool_call>\n</think>The answer.';
    expect(stripNarratedToolCalls(reply, OFFERED)).toEqual({ text: reply, toolNames: [] });
  });

  it('strips a block in the answer between reasoning spans', () => {
    const reply =
      '<think>plan</think>Checking.\n<tool_call>{"name":"web_search","arguments":{}}</tool_call>\n<think>again</think>Done.';
    expect(stripNarratedToolCalls(reply, OFFERED).text).toBe('<think>plan</think>Checking.\n<think>again</think>Done.');
  });
});

describe('stripNarratedToolCallsFromReplies', () => {
  it('strips every slot and collects the named tools once each', () => {
    const call = '<tool_call>{"name":"web_search","arguments":{}}</tool_call>';
    const result = stripNarratedToolCallsFromReplies([`A\n${call}`, 'plain', `B\n${call}`], OFFERED);
    expect(result.replies).toEqual(['A\n', 'plain', 'B\n']);
    expect(result.toolNames).toEqual(['web_search']);
  });
});

describe('applyNarratedToolCallStrip', () => {
  it('strips the stored reply and slots and returns the named tools', () => {
    const narrated = 'Checking.\n<tool_call>{"name":"web_search","arguments":{}}</tool_call>';
    const quest = { reply: narrated, replies: [narrated] };
    expect(applyNarratedToolCallStrip(quest, ['web_search'])).toEqual(['web_search']);
    expect(quest).toEqual({ reply: 'Checking.\n', replies: ['Checking.\n'] });
  });

  it('leaves a quest with no narrated call unchanged', () => {
    const quest = { reply: 'Hi.', replies: ['Hi.'] };
    expect(applyNarratedToolCallStrip(quest, ['web_search'])).toEqual([]);
    expect(quest).toEqual({ reply: 'Hi.', replies: ['Hi.'] });
  });
});
