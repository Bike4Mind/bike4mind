import { describe, expect, it } from 'vitest';
import type { IMessage } from '@bike4mind/common';
import { attachPreToolText, replayableText } from './replayPreToolText';

const toolCallMessage = (content: string | null, id = 'call_1') =>
  ({
    role: 'assistant',
    content,
    tool_calls: [{ id, type: 'function', function: { name: 'search', arguments: '{}' } }],
  }) as unknown as IMessage;

const toolResult = (id = 'call_1') => ({ role: 'tool', content: 'ok', tool_call_id: id }) as unknown as IMessage;

describe('replayableText', () => {
  it.each([null, undefined, '', '  \n'])('drops %j', value => {
    expect(replayableText(value)).toBeUndefined();
  });

  it('returns text with visible characters unchanged', () => {
    expect(replayableText(' Plan: 1, 2, 3 ')).toBe(' Plan: 1, 2, 3 ');
  });
});

describe('attachPreToolText', () => {
  it('sets the text on the first assistant tool-call message of the round', () => {
    const messages = [{ role: 'user', content: 'hi' } as IMessage, toolCallMessage(null), toolResult()];
    attachPreToolText(messages, 1, 'Plan: 1, 2, 3');
    expect(messages[1].content).toBe('Plan: 1, 2, 3');
  });

  it('replaces the empty-string content some backends push', () => {
    const messages = [toolCallMessage(''), toolResult()];
    attachPreToolText(messages, 0, 'Plan');
    expect(messages[0].content).toBe('Plan');
  });

  it('leaves later assistant messages in a per-call split round untouched', () => {
    const messages = [toolCallMessage(null, 'a'), toolResult('a'), toolCallMessage(null, 'b'), toolResult('b')];
    attachPreToolText(messages, 0, 'Plan');
    expect(messages[0].content).toBe('Plan');
    expect(messages[2].content).toBeNull();
  });

  it('does nothing for blank text', () => {
    const messages = [toolCallMessage(null), toolResult()];
    attachPreToolText(messages, 0, '  ');
    expect(messages[0].content).toBeNull();
  });

  it('does not overwrite content already on the message', () => {
    const messages = [toolCallMessage('existing'), toolResult()];
    attachPreToolText(messages, 0, 'Plan');
    expect(messages[0].content).toBe('existing');
  });

  it('does nothing when the index does not point at an assistant tool-call message', () => {
    const messages = [toolResult(), { role: 'assistant', content: null } as IMessage];
    attachPreToolText(messages, 0, 'Plan');
    attachPreToolText(messages, 1, 'Plan');
    attachPreToolText(messages, 5, 'Plan');
    expect(messages[0].content).toBe('ok');
    expect(messages[1].content).toBeNull();
  });
});
