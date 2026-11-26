import { BadRequestError } from './errors';
import type { IMessage } from './types/entities/MessageTypes';

export const EMPTY_CONVERSATION_MESSAGE = 'request must contain at least one non-empty user or assistant message';

/**
 * A request with no user or assistant message a model can read (system-only, or only blank text).
 * Caller input, not a server fault: a 400 on the public API, and a warn-level settled quest on the
 * chat path (ChatCompletionProcess). Thrown by every backend's payload sanitizer and by the
 * pre-flight guards that run before a provider call.
 */
export class EmptyConversationError extends BadRequestError {
  constructor() {
    super(EMPTY_CONVERSATION_MESSAGE);
    this.name = 'EmptyConversationError';
  }
}

export function isEmptyConversationError(error: unknown): error is EmptyConversationError {
  return error instanceof EmptyConversationError;
}

/**
 * True when at least one user or assistant message carries something a provider can read: non-blank
 * text, a non-text block (image, document, tool_use, tool_result), or tool calls. Mirrors what the
 * backend sanitizers keep, so a false here means the provider call would throw EmptyConversationError.
 */
export function hasReadableConversationMessage(messages: readonly IMessage[]): boolean {
  return messages.some(message => {
    if (message.role !== 'user' && message.role !== 'assistant') return false;
    if ('tool_calls' in message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
    if (typeof message.content === 'string') return message.content.trim().length > 0;
    return Array.isArray(message.content)
      ? message.content.some(block => block.type !== 'text' || Boolean(block.text?.trim()))
      : false;
  });
}
