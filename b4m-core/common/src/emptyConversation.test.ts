import { describe, expect, it } from 'vitest';
import { BadRequestError } from './errors';
import {
  EMPTY_CONVERSATION_MESSAGE,
  EmptyConversationError,
  hasReadableConversationMessage,
  isEmptyConversationError,
} from './emptyConversation';
import type { IMessage } from './types/entities/MessageTypes';

describe('hasReadableConversationMessage', () => {
  it.each<[string, IMessage[]]>([
    ['no messages', []],
    ['system-only', [{ role: 'system', content: 'You are helpful.' }]],
    [
      'a blank prompt after system context',
      [
        { role: 'system', content: 'ctx' },
        { role: 'user', content: '' },
      ],
    ],
    ['a whitespace-only prompt', [{ role: 'user', content: ' \n\t ' }]],
    ['only blank text blocks', [{ role: 'assistant', content: [{ type: 'text', text: '  ' }] }]],
    ['an empty block array', [{ role: 'user', content: [] }]],
  ])('is false for %s', (_label, messages) => {
    expect(hasReadableConversationMessage(messages)).toBe(false);
  });

  it.each<[string, IMessage[]]>([
    ['a normal prompt', [{ role: 'user', content: 'Hello' }]],
    [
      'a reply in history',
      [
        { role: 'user', content: '' },
        { role: 'assistant', content: 'Earlier answer' },
      ],
    ],
    [
      'an image-only prompt',
      [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }],
    ],
    [
      'an assistant turn that only carries tool calls',
      [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'web_search', arguments: '{}' } }],
        } as IMessage,
      ],
    ],
    [
      'a tool_result-only user message',
      [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] }],
    ],
    [
      'a blank prompt with an attached file as a user message',
      [
        { role: 'user', content: 'Attached file contents' },
        { role: 'user', content: '' },
      ],
    ],
  ])('is true for %s', (_label, messages) => {
    expect(hasReadableConversationMessage(messages)).toBe(true);
  });
});

describe('EmptyConversationError', () => {
  it('is a 400 BadRequestError with the shared message, so API callers keep their contract', () => {
    const error = new EmptyConversationError();
    expect(error).toBeInstanceOf(BadRequestError);
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(EMPTY_CONVERSATION_MESSAGE);
    expect(isEmptyConversationError(error)).toBe(true);
    expect(isEmptyConversationError(new BadRequestError(EMPTY_CONVERSATION_MESSAGE))).toBe(false);
  });
});
