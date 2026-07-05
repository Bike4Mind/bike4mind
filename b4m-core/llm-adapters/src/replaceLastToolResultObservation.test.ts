import { describe, it, expect } from 'vitest';
import type { IMessage } from '@bike4mind/common';
import {
  replaceLastToolResultObservationCanonical,
  replaceLastToolResultObservationOpenAI,
  getLatestToolCallIdCanonical,
  getLatestToolCallIdOpenAI,
} from './backend';

describe('replaceLastToolResultObservationCanonical (Anthropic-style)', () => {
  it('replaces the matching tool_result block content in place', () => {
    const messages: IMessage[] = [
      { role: 'user', content: 'do a thing' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_abc', name: 'delegate_to_agent', input: { task: 't' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'PLACEHOLDER' }],
      },
    ];

    replaceLastToolResultObservationCanonical(messages, 'toolu_abc', 'real subagent answer');

    const lastUserMsg = messages[messages.length - 1];
    expect(Array.isArray(lastUserMsg.content)).toBe(true);
    const block = (lastUserMsg.content as Array<{ content?: string }>)[0];
    expect(block.content).toBe('real subagent answer');
  });

  it('finds the most recent matching tool_use_id even with intervening unrelated messages', () => {
    const messages: IMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: 'older' }],
      },
      { role: 'assistant', content: 'thinking...' },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_new', content: 'PLACEHOLDER' }],
      },
    ];

    replaceLastToolResultObservationCanonical(messages, 'toolu_new', 'updated');

    const oldBlock = (messages[0].content as Array<{ content?: string }>)[0];
    const newBlock = (messages[2].content as Array<{ content?: string }>)[0];
    expect(oldBlock.content).toBe('older'); // unchanged
    expect(newBlock.content).toBe('updated');
  });

  it('throws when no matching tool_result block exists', () => {
    const messages: IMessage[] = [
      { role: 'user', content: 'no tool calls here' },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_other', content: 'x' }],
      },
    ];

    expect(() => replaceLastToolResultObservationCanonical(messages, 'toolu_missing', 'x')).toThrow(
      /no Anthropic-style tool_result block/
    );
  });
});

describe('replaceLastToolResultObservationOpenAI (OpenAI-style)', () => {
  it('replaces the most recent role=tool message with matching tool_call_id', () => {
    const messages: Array<IMessage & { tool_call_id?: string }> = [
      { role: 'user', content: 'do a thing' },
      { role: 'assistant', content: null as unknown as string },
      { role: 'tool', content: 'PLACEHOLDER', tool_call_id: 'call_abc' },
    ];

    replaceLastToolResultObservationOpenAI(messages, 'call_abc', 'real answer');

    expect(messages[2].content).toBe('real answer');
  });

  it('throws when no matching role=tool message exists', () => {
    const messages: IMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ];

    expect(() => replaceLastToolResultObservationOpenAI(messages, 'call_x', 'y')).toThrow(/no role=tool message/);
  });

  it('matches the LAST occurrence when multiple role=tool messages exist', () => {
    const messages: Array<IMessage & { tool_call_id?: string }> = [
      { role: 'tool', content: 'first', tool_call_id: 'call_dup' },
      { role: 'assistant', content: 'between' },
      { role: 'tool', content: 'second_PLACEHOLDER', tool_call_id: 'call_dup' },
    ];

    replaceLastToolResultObservationOpenAI(messages, 'call_dup', 'replaced');

    expect(messages[0].content).toBe('first'); // unchanged
    expect(messages[2].content).toBe('replaced');
  });
});

describe('getLatestToolCallIdCanonical (Anthropic-style)', () => {
  it('returns the id of the most recent tool_use block matching toolName', () => {
    const messages: IMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_old', name: 'other_tool', input: {} }],
      },
      { role: 'user', content: 'continue' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking…' },
          { type: 'tool_use', id: 'toolu_new', name: 'delegate_to_agent', input: { task: 't' } },
        ],
      },
    ];

    expect(getLatestToolCallIdCanonical(messages, 'delegate_to_agent')).toBe('toolu_new');
  });

  it('returns undefined when no matching tool_use block exists', () => {
    const messages: IMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_x', name: 'other_tool', input: {} }],
      },
    ];

    expect(getLatestToolCallIdCanonical(messages, 'delegate_to_agent')).toBeUndefined();
  });

  it('skips messages whose content is a string', () => {
    const messages: IMessage[] = [
      { role: 'assistant', content: 'no tool calls in this turn' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_y', name: 'delegate_to_agent', input: {} }],
      },
    ];

    expect(getLatestToolCallIdCanonical(messages, 'delegate_to_agent')).toBe('toolu_y');
  });

  it('returns the LAST matching block within a single assistant message (parallel tool use)', () => {
    // Symmetric with getLatestToolCallIdOpenAI - both iterate inner array in reverse.
    const messages: IMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_first', name: 'delegate_to_agent', input: {} },
          { type: 'text', text: 'reasoning' },
          { type: 'tool_use', id: 'toolu_last', name: 'delegate_to_agent', input: {} },
        ],
      },
    ];

    expect(getLatestToolCallIdCanonical(messages, 'delegate_to_agent')).toBe('toolu_last');
  });
});

describe('getLatestToolCallIdOpenAI (OpenAI-style)', () => {
  it('returns the id of the most recent assistant.tool_calls entry matching toolName', () => {
    const messages: Array<
      IMessage & { tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }
    > = [
      {
        role: 'assistant',
        content: null as unknown as string,
        tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'other_tool', arguments: '{}' } }],
      },
      { role: 'tool', content: 'r' } as IMessage & { tool_call_id?: string },
      {
        role: 'assistant',
        content: null as unknown as string,
        tool_calls: [
          { id: 'call_new', type: 'function', function: { name: 'delegate_to_agent', arguments: '{"task":"t"}' } },
        ],
      },
    ];

    expect(getLatestToolCallIdOpenAI(messages, 'delegate_to_agent')).toBe('call_new');
  });

  it('returns undefined when no matching function name is present', () => {
    const messages: Array<IMessage & { tool_calls?: Array<{ id: string; function: { name: string } }> }> = [
      {
        role: 'assistant',
        content: null as unknown as string,
        tool_calls: [{ id: 'call_a', function: { name: 'other_tool' } }],
      },
    ];

    expect(getLatestToolCallIdOpenAI(messages, 'delegate_to_agent')).toBeUndefined();
  });

  it('picks the latest tool_call within a single assistant message when names match multiple', () => {
    const messages: Array<IMessage & { tool_calls?: Array<{ id: string; function: { name: string } }> }> = [
      {
        role: 'assistant',
        content: null as unknown as string,
        tool_calls: [
          { id: 'call_first', function: { name: 'delegate_to_agent' } },
          { id: 'call_second', function: { name: 'delegate_to_agent' } },
        ],
      },
    ];

    // Inner loop scans from the end of tool_calls -> returns the LAST matching call.
    expect(getLatestToolCallIdOpenAI(messages, 'delegate_to_agent')).toBe('call_second');
  });
});
