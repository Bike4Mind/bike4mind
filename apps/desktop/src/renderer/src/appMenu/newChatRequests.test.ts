import { describe, expect, it } from 'vitest';
import { NEW_CHAT_REQUEST_TTL_MS, requestNewChat, takeNewChatRequest } from './newChatRequests';

describe('new chat requests', () => {
  it('hands a request over once', () => {
    requestNewChat(1_000);
    expect(takeNewChatRequest(1_100)).toBe(true);
    expect(takeNewChatRequest(1_200)).toBe(false);
  });

  it('drops a request no chat view took in time', () => {
    requestNewChat(1_000);
    expect(takeNewChatRequest(1_000 + NEW_CHAT_REQUEST_TTL_MS + 1)).toBe(false);
    expect(takeNewChatRequest(1_000 + NEW_CHAT_REQUEST_TTL_MS + 2)).toBe(false);
  });
});
