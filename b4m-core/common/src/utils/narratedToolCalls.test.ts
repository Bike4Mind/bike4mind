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

  it('keeps prose that follows a closed block, and reports that the reply did not end on the call', () => {
    const reply = 'Checking.\n<tool_call>{"name":"web_search","arguments":{}}</tool_call>\nThe tide is high.';
    expect(stripNarratedToolCalls(reply, OFFERED)).toEqual({
      text: 'Checking.\nThe tide is high.',
      toolNames: ['web_search'],
      endsOnCall: false,
    });
  });

  it('reports a reply that ends on the stripped call, ignoring reasoning after it', () => {
    const reply = 'Checking.\n<tool_call>{"name":"web_search","arguments":{}}</tool_call>\n<think>wait</think>';
    expect(stripNarratedToolCalls(reply, OFFERED).endsOnCall).toBe(true);
  });

  it('hides every narrated block in a reply', () => {
    const call = (name: string) => `<tool_call>{"name":"${name}","arguments":{}}</tool_call>`;
    const result = stripNarratedToolCalls(`A\n${call('web_search')}\n${call('get_weather')}\nB`, OFFERED);
    expect(result.text).toBe('A\nB');
    expect(result.toolNames).toEqual(['web_search', 'get_weather']);
  });

  it('only strips at finalize when the block names a tool offered on the turn', () => {
    const reply = 'Here.\n<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>';
    expect(stripNarratedToolCalls(reply, OFFERED)).toEqual({ text: reply, toolNames: [], endsOnCall: false });
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
      expect(stripNarratedToolCalls(reply, OFFERED)).toEqual({ text: reply, toolNames: [], endsOnCall: false });
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
    // Generous for a loaded runner; the quadratic scan this guards against took about 3s here.
    expect(performance.now() - started).toBeLessThan(1000);
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
    expect(stripNarratedToolCalls(reply, OFFERED)).toEqual({ text: reply, toolNames: [], endsOnCall: false });
    expect(stripNarratedToolCalls(reply).text).toBe(reply);
  });

  it('leaves a narrated block inside reasoning alone', () => {
    const reply = '<think>\n<tool_call>{"name":"web_search","arguments":{}}</tool_call>\n</think>The answer.';
    expect(stripNarratedToolCalls(reply, OFFERED)).toEqual({ text: reply, toolNames: [], endsOnCall: false });
  });

  it('leaves a fenced example alone when a reasoning span sits inside the fence', () => {
    const reply =
      'Example:\n```\n<think>aside</think>\n<tool_call>{"name":"web_search","arguments":{}}</tool_call>\n```\nDone.';
    expect(stripNarratedToolCalls(reply, OFFERED)).toEqual({ text: reply, toolNames: [], endsOnCall: false });
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
    expect(result.endsOnCall).toBe(true);
    expect(stripNarratedToolCallsFromReplies([`A\n${call}`, 'An answer.'], OFFERED).endsOnCall).toBe(false);
  });

  // The client joins slots with '', so a fence opened in one slot still holds in the next.
  it('leaves a call alone inside a code fence that spans reply slots', () => {
    const call = '<tool_call>{"name":"web_search","arguments":{}}</tool_call>';
    const replies = ['Example:\n```\n', `${call}\n`, '```\nDone.'];
    expect(stripNarratedToolCallsFromReplies(replies, OFFERED)).toEqual({ replies, toolNames: [], endsOnCall: false });
  });

  it('removes a cut-off call naming an offered tool from the last slot of a truncated reply', () => {
    const cut = '<tool_call>\n{"name": "web_search", "arguments": {"query": "ti';
    const result = stripNarratedToolCallsFromReplies(['Let me check.\n', cut], { ...OFFERED, truncated: true });
    expect(result).toEqual({ replies: ['Let me check.\n', ''], toolNames: ['web_search'], endsOnCall: true });
  });
});

describe('stripNarratedToolCalls on a truncated reply', () => {
  const TRUNCATED = { ...OFFERED, truncated: true };

  it.each([
    ['tool_call JSON', '<tool_call>\n{"name": "web_search", "arguments": {"query": "ti'],
    ['tool_call function tag', '<tool_call>\n<function=web_search>\n<parameter=query>ti'],
    ['function_calls invoke', '<function_calls>\n<invoke name="web_search">\n<parameter name="query">ti'],
    ['TOOL_CALLS array', '[TOOL_CALLS][{"name": "web_search", "arguments": {"query": "ti'],
    ['TOOL_CALLS args form', '[TOOL_CALLS]web_search[ARGS]{"query": "ti'],
  ])('removes a cut-off %s block naming an offered tool', (_form, cut) => {
    expect(stripNarratedToolCalls(`Let me check.\n${cut}`, TRUNCATED)).toEqual({
      text: 'Let me check.\n',
      toolNames: ['web_search'],
      endsOnCall: true,
    });
  });

  it('keeps a cut-off block that names no offered tool', () => {
    const reply = 'Let me check.\n<tool_call>\n{"name": "send_email", "arguments": {"to": "a';
    expect(stripNarratedToolCalls(reply, TRUNCATED)).toEqual({ text: reply, toolNames: [], endsOnCall: false });
  });

  it('keeps a cut-off block whose tool name is not complete yet', () => {
    const reply = 'Let me check.\n<tool_call>\n{"name": "web_sea';
    expect(stripNarratedToolCalls(reply, TRUNCATED).text).toBe(reply);
  });

  it('keeps an unclosed block on a reply that was not truncated', () => {
    const reply = 'Let me check.\n<tool_call>\n{"name": "web_search", "arguments": {"query": "ti';
    expect(stripNarratedToolCalls(reply, OFFERED).text).toBe(reply);
  });

  // Visible text after a think span means the block was not where the reply was cut off.
  it('keeps an unclosed block that visible text follows', () => {
    const reply = 'A\n<tool_call>\n{"name": "web_search"<think>hm</think>The answer.';
    expect(stripNarratedToolCalls(reply, TRUNCATED).text).toBe(reply);
  });
});

describe('applyNarratedToolCallStrip', () => {
  it('strips the stored reply and slots and returns the named tools', () => {
    const narrated = 'Checking.\n<tool_call>{"name":"web_search","arguments":{}}</tool_call>';
    const quest = { reply: narrated, replies: [narrated] };
    expect(applyNarratedToolCallStrip(quest, ['web_search'])).toEqual({ toolNames: ['web_search'], endsOnCall: true });
    expect(quest).toEqual({ reply: 'Checking.\n', replies: ['Checking.\n'] });
  });

  it('removes a cut-off call from a truncated quest', () => {
    const cut = 'Checking.\n<tool_call>{"name":"web_search","arguments":{"q';
    const quest = { reply: cut, replies: [cut] };
    expect(applyNarratedToolCallStrip(quest, ['web_search'], { truncated: true })).toEqual({
      toolNames: ['web_search'],
      endsOnCall: true,
    });
    expect(quest).toEqual({ reply: 'Checking.\n', replies: ['Checking.\n'] });
  });

  it('leaves a quest with no narrated call unchanged', () => {
    const quest = { reply: 'Hi.', replies: ['Hi.'] };
    expect(applyNarratedToolCallStrip(quest, ['web_search'])).toEqual({ toolNames: [], endsOnCall: false });
    expect(quest).toEqual({ reply: 'Hi.', replies: ['Hi.'] });
  });
});
