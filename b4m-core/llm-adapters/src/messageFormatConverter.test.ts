import { describe, it, expect } from 'vitest';
import { convertMessagesToOpenAIFormat, convertOpenAIToolHistoryToCanonical } from './messageFormatConverter';
import type { IMessage } from '@bike4mind/common';

/**
 * Regression guard: the converter only rewrites tool_use/tool_result blocks. A
 * multimodal user message (image_url or inline image) carries no such block and
 * MUST pass through unchanged so OpenAI and xAI still receive the image content.
 * The Ollama backend does its own image mapping downstream in buildMessages.
 */
describe('convertMessagesToOpenAIFormat - image content pass-through', () => {
  it('passes a user message with an image_url block through unchanged', () => {
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ],
    } as IMessage;

    const result = convertMessagesToOpenAIFormat([message]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(message);
  });

  it('passes a user message with an inline base64 image block through unchanged', () => {
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } },
      ],
    } as IMessage;

    const result = convertMessagesToOpenAIFormat([message]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(message);
  });

  // `requiresTool` decides whether a prompt survives a tools-dropped turn; it is ours, and OpenAI,
  // xAI and Kimi all send whatever this converter returns straight into the request body.
  it('strips the requiresTool control field instead of sending it to the provider', () => {
    const message = {
      role: 'system',
      content: 'you MUST use the image_generation tool',
      requiresTool: 'image_generation',
    } as IMessage;

    const result = convertMessagesToOpenAIFormat([message]);

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('requiresTool');
    expect(result[0]).toEqual({ role: 'system', content: 'you MUST use the image_generation tool' });
  });

  // Same contract for the other two control-only fields: `cache` declares an Anthropic breakpoint,
  // `perTurn` marks a message the service moved into the user turn (and may leave behind for a
  // caller that opted out of relocation). Neither provider should ever see them.
  it('strips the cache and perTurn control fields instead of sending them to the provider', () => {
    const anchored = { role: 'assistant', content: 'earlier answer', cache: true } as IMessage;
    const perTurn = { role: 'system', content: 'view context', perTurn: true } as IMessage;

    const result = convertMessagesToOpenAIFormat([anchored, perTurn]);

    expect(result).toEqual([
      { role: 'assistant', content: 'earlier answer' },
      { role: 'system', content: 'view context' },
    ]);
  });
});

// Shape mirrors b4m-core/utils/src/llm/utils.ts's Priority 2 tool-pairing reconstruction
// (fetchAndProcessPreviousMessages), which builds exactly this assistant tool_use / user
// tool_result pair from promptMeta.functionCalls[].returnValue - the field this repo's
// backends only recently started writing. Confirms the reconstructed history round-trips
// into a valid OpenAI-shaped request (tool_calls + role:'tool'), not just that utils.ts
// assembles the intermediate IMessage array correctly.
describe('convertMessagesToOpenAIFormat - replayed tool history (utils.ts Priority 2 shape)', () => {
  it('converts a reconstructed tool_use/tool_result pair into tool_calls + role:tool', () => {
    const assistantMessage: IMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reply 1' },
        { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'weather' } },
      ],
    } as IMessage;
    const toolResultMessage: IMessage = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny', is_error: false }],
    } as IMessage;

    const result = convertMessagesToOpenAIFormat([assistantMessage, toolResultMessage]);

    expect(result).toEqual([
      {
        role: 'assistant',
        content: 'reply 1',
        tool_calls: [
          { id: 'toolu_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"weather"}' } },
        ],
      },
      { role: 'tool', content: 'sunny', tool_call_id: 'toolu_1' },
    ]);
  });
});

/**
 * `reasoning_content` is DeepSeek's and nobody else's. deepseekBackend's
 * pushToolMessages mutates the caller's message array in place, and
 * ChatCompletionProcess builds that array once and hands the same object to every
 * backend the fallback loop tries - so a DeepSeek turn that 429s mid-tool-loop and
 * hops to GPT-4.1 reaches openaiBackend.formatMessages with the field still on the
 * message. That hop exists to rescue a failing turn; it must not depend on the
 * rescuer tolerating a foreign provider's field.
 */
describe('convertMessagesToOpenAIFormat - reasoning_content on a fallback hop', () => {
  const deepseekToolTurn = () =>
    ({
      role: 'assistant',
      content: null,
      reasoning_content: 'step one',
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
    }) as unknown as IMessage;

  it('replays reasoning_content only when the caller opts in', () => {
    const result = convertMessagesToOpenAIFormat([deepseekToolTurn()], { preserveReasoningContent: true });

    expect(result[0]).toHaveProperty('reasoning_content', 'step one');
  });

  it('strips it by default, which is what every non-DeepSeek target gets', () => {
    const result = convertMessagesToOpenAIFormat([deepseekToolTurn()]);

    expect(result[0]).not.toHaveProperty('reasoning_content');
    expect(result[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
    });
  });

  it('leaves the source message untouched, the array being shared with the next hop', () => {
    const message = deepseekToolTurn();

    convertMessagesToOpenAIFormat([message]);

    expect(message).toHaveProperty('reasoning_content', 'step one');
  });
});

describe('convertOpenAIToolHistoryToCanonical', () => {
  const openAIRound = (): IMessage[] =>
    [
      { role: 'user', content: 'find a and b' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'search twice',
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"a"}' } },
          { id: 't2', type: 'function', function: { name: 'search', arguments: 'not json' } },
        ],
      },
      { role: 'tool', content: '{"result":"A"}', tool_call_id: 't1' },
      { role: 'tool', content: '{"result":"B"}', tool_call_id: 't2' },
    ] as unknown as IMessage[];

  it('returns the same array when there is no OpenAI-shape tool history', () => {
    const messages = [{ role: 'user', content: 'hi' }] as IMessage[];
    expect(convertOpenAIToolHistoryToCanonical(messages)).toBe(messages);
  });

  it('rewrites tool_calls into tool_use blocks and folds tool messages into one tool_result turn', () => {
    const messages = openAIRound();

    const result = convertOpenAIToolHistoryToCanonical(messages);

    expect(result[0]).toBe(messages[0]);
    expect(result.slice(1)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'search', input: { q: 'a' } },
          // Unparseable arguments degrade to an empty input rather than failing the hop.
          { type: 'tool_use', id: 't2', name: 'search', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: '{"result":"A"}' },
          { type: 'tool_result', tool_use_id: 't2', content: '{"result":"B"}' },
        ],
      },
    ]);
  });

  it('drops the DeepSeek-private reasoning_content', () => {
    const [, assistant] = convertOpenAIToolHistoryToCanonical(openAIRound());
    expect(assistant).not.toHaveProperty('reasoning_content');
  });

  it('keeps assistant text alongside the tool_use blocks', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'let me look',
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{}' } }],
      },
      { role: 'tool', content: 'r', tool_call_id: 't1' },
    ] as unknown as IMessage[];

    const [assistant] = convertOpenAIToolHistoryToCanonical(messages);

    expect(assistant.content).toEqual([
      { type: 'text', text: 'let me look' },
      { type: 'tool_use', id: 't1', name: 'search', input: {} },
    ]);
  });

  it('round-trips back to the same OpenAI tool history', () => {
    const canonical = convertOpenAIToolHistoryToCanonical(openAIRound());
    const [, assistant, ...tools] = convertMessagesToOpenAIFormat(canonical) as Array<Record<string, unknown>>;

    expect(assistant.tool_calls).toEqual([
      { id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"a"}' } },
      { id: 't2', type: 'function', function: { name: 'search', arguments: '{}' } },
    ]);
    expect(tools).toEqual([
      { role: 'tool', content: '{"result":"A"}', tool_call_id: 't1' },
      { role: 'tool', content: '{"result":"B"}', tool_call_id: 't2' },
    ]);
  });

  it("folds Gemini's role: 'tool' messages, which already carry tool_result blocks, into a user turn", () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search', input: {} }] },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
    ] as unknown as IMessage[];

    const [assistant, results] = convertOpenAIToolHistoryToCanonical(messages);

    expect(assistant).toBe(messages[0]);
    expect(results).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] });
  });
});
