import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  fitToContext,
  LOCAL_CONTEXT_TARGET_TOKENS,
  localContextTokens,
  localTranscriptChars,
  overflowTokens,
  shrunkTranscriptChars,
  type OllamaMessage,
} from './localContext';

describe('localContextTokens', () => {
  it.each([
    { limit: undefined, configured: undefined, expected: LOCAL_CONTEXT_TARGET_TOKENS },
    { limit: 32768, configured: undefined, expected: 16384 },
    { limit: 262144, configured: undefined, expected: 16384 },
    { limit: 8192, configured: undefined, expected: 8192 },
    { limit: 32768, configured: 2048, expected: 16384 },
    { limit: 131072, configured: 65536, expected: 65536 },
    { limit: 32768, configured: 65536, expected: 32768 },
  ])('sizes $limit / $configured to $expected', ({ limit, configured, expected }) => {
    expect(localContextTokens(limit, configured)).toBe(expected);
  });
});

describe('estimateTokens', () => {
  it('counts text, tool calls, images and tool schemas', () => {
    expect(estimateTokens([{ role: 'user', content: 'x'.repeat(400) }])).toBe(104);
    expect(estimateTokens([{ role: 'user', content: '', images: ['a', 'b'] }])).toBe(2 * 768 + 4);
    const call = { function: { name: 'f', arguments: {} } };
    expect(estimateTokens([{ role: 'assistant', content: '', tool_calls: [call] }])).toBe(
      Math.ceil(JSON.stringify([call]).length / 4) + 4
    );
    const tools = [{ type: 'function', function: { name: 'x'.repeat(1000) } }];
    expect(estimateTokens([], tools)).toBe(Math.ceil(JSON.stringify(tools).length / 4));
  });
});

describe('fitToContext', () => {
  const text = (role: string, chars: number, tag = role): OllamaMessage => ({
    role,
    content: tag + 'x'.repeat(Math.max(0, chars - tag.length)),
  });
  const tags = (messages: OllamaMessage[]) => messages.map(message => message.content.replace(/x+$/, ''));

  it('sends everything that fits', () => {
    const messages = [text('system', 4000), text('user', 400), text('assistant', 400), text('user', 400)];
    expect(fitToContext(messages, [], 4096)).toEqual({ messages, dropped: 0, visible: 0 });
  });

  it('drops the oldest whole turns, never the system prompt or the latest turn', () => {
    const messages = [
      text('system', 4000, 'sys'),
      text('user', 4000, 'u1'),
      text('assistant', 4000, 'a1'),
      text('user', 4000, 'u2'),
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'f', arguments: {} } }] },
      text('tool', 2000, 't2'),
      text('assistant', 400, 'a2'),
      text('user', 400, 'u3'),
    ];
    // 4096 minus the 1024 reserve leaves 3072 tokens: the system prompt and the last two turns.
    const fit = fitToContext(messages, [], 4096);
    expect(tags(fit.messages)).toEqual(['sys', 'u2', '', 't2', 'a2', 'u3']);
    expect(fit.dropped).toBe(2);
  });

  it('keeps the latest turn even when it alone overflows', () => {
    const messages = [text('system', 400, 'sys'), text('user', 400, 'u1'), text('user', 40_000, 'u2')];
    expect(tags(fitToContext(messages, [], 4096).messages)).toEqual(['sys', 'u2']);
  });

  it('counts tool schemas and leaves room for the reply', () => {
    const messages = [text('system', 400, 'sys'), text('user', 2400, 'u1'), text('user', 400, 'u2')];
    const tools = [{ type: 'function', function: { description: 'x'.repeat(10_000) } }];
    expect(tags(fitToContext(messages, [], 4096).messages)).toEqual(['sys', 'u1', 'u2']);
    expect(tags(fitToContext(messages, tools, 4096).messages)).toEqual(['sys', 'u2']);
    expect(tags(fitToContext(messages, [], 1024, 64).messages)).toEqual(['sys', 'u1', 'u2']);
    expect(tags(fitToContext(messages, [], 1024).messages)).toEqual(['sys', 'u2']);
  });

  it('drops more when the estimate is scaled up', () => {
    const messages = [text('system', 400, 'sys'), text('user', 4000, 'u1'), text('user', 400, 'u2')];
    expect(fitToContext(messages, [], 4096).dropped).toBe(0);
    expect(tags(fitToContext(messages, [], 4096, undefined, 3).messages)).toEqual(['sys', 'u2']);
  });

  it('drops assistant messages that precede the first user message with the first turn', () => {
    const messages = [text('system', 400, 'sys'), text('assistant', 8000, 'a0'), text('user', 400, 'u1')];
    expect(tags(fitToContext(messages, [], 2048).messages)).toEqual(['sys', 'u1']);
  });

  it('leaves a conversation with no user message alone', () => {
    const messages = [text('system', 40_000, 'sys')];
    expect(fitToContext(messages, [], 2048)).toEqual({ messages, dropped: 0, visible: 0 });
  });

  const call = (name: string, content = ''): OllamaMessage => ({
    role: 'assistant',
    content,
    tool_calls: [{ function: { name, arguments: {} } }],
  });

  it('keeps the request of a turn whose tool screenshots arrive as user messages', () => {
    const messages: OllamaMessage[] = [
      text('system', 40_000, 'sys'),
      text('user', 400, 'u-old'),
      text('assistant', 400, 'a-old'),
      text('user', 60, 'u-request'),
      call('read_file'),
      text('tool', 12_000, 't-file'),
      call('browser_screenshot'),
      text('tool', 20, 't-shot'),
      { role: 'user', content: 'u-images', images: ['AAAA'], continuesTurn: true },
      call('browser_click'),
      text('tool', 2000, 't-click'),
    ];
    const fit = fitToContext(messages, [], LOCAL_CONTEXT_TARGET_TOKENS);
    expect(tags(fit.messages)).toEqual(['sys', 'u-request', '', 't-file', '', 't-shot', 'u-images', '', 't-click']);
    expect(fit.dropped).toBe(2);
  });

  it('drops a screenshot message together with the turn it belongs to, counting what the user sees', () => {
    const messages = [
      text('system', 400, 'sys'),
      text('user', 8000, 'u1'),
      call('f'),
      text('tool', 400, 't1'),
      { ...text('user', 400, 'u1-images'), continuesTurn: true },
      call('g', 'a1-progress'),
      text('tool', 400, 't1b'),
      text('assistant', 400, 'a1'),
      text('user', 400, 'u2'),
    ];
    const fit = fitToContext(messages, [], 2048);
    expect(tags(fit.messages)).toEqual(['sys', 'u2']);
    expect(fit.dropped).toBe(7);
    // The prompt and its one reply, however many tool rounds and screenshots it took.
    expect(fit.visible).toBe(2);
  });

  it('starts a turn at every prompt of a replayed history whose replies used tools', () => {
    // ChatService replays a stored tool turn as assistant(tool_use) + its results, so each later
    // prompt follows a tool message.
    const messages: OllamaMessage[] = [text('system', 400, 'sys')];
    for (let turn = 0; turn < 4; turn++)
      messages.push(text('user', 40, `u${turn}`), call('read_file', `a${turn}`), text('tool', 3200, `t${turn}`));
    messages.push(text('user', 40, 'latest'));
    const fit = fitToContext(messages, [], 2048);
    expect(tags(fit.messages)).toEqual(['sys', 'u3', 'a3', 't3', 'latest']);
    expect(fit.visible).toBe(6);
  });
});

describe('shrunkTranscriptChars', () => {
  it('scales the transcript by what Ollama measured, with a margin, leaving room for the reply', () => {
    expect(shrunkTranscriptChars(41_472, 24_584, 16_384, 1536)).toBe(
      Math.floor((41_472 * (16_384 - 1536) * 0.9) / 24_584)
    );
  });
});

describe('localTranscriptChars', () => {
  it('leaves room for the reply and the instruction, at three characters a token', () => {
    expect(localTranscriptChars(16_384, 1536)).toBe((16_384 - 1536 - 1024) * 3);
  });

  it('never goes below a quarter of the window', () => {
    expect(localTranscriptChars(2048, 1536)).toBe(512 * 3);
  });
});

describe('overflowTokens', () => {
  it('reads the prompt size from the refusal Ollama sends with truncate off', () => {
    expect(
      overflowTokens('request (10569 tokens) exceeds the available context size (4096 tokens), try increasing it')
    ).toBe(10569);
    expect(overflowTokens('model is busy')).toBeUndefined();
  });
});
