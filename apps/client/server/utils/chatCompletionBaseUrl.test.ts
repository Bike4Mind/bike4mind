import { afterEach, describe, expect, it, vi } from 'vitest';

const mockResource = vi.hoisted(() => ({ ChatCompletion: { url: '' } }));
vi.mock('sst', () => ({ Resource: mockResource }));

import { chatCompletionBaseUrl } from './chatCompletionBaseUrl';

describe('chatCompletionBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['http://chat-completion.internal', 'http://chat-completion.internal'],
    ['https://chat-origin.app.example.test/', 'https://chat-origin.app.example.test'],
    ['http://chatcompletion:8080', 'http://chatcompletion:8080'],
  ])('returns %s as %s', (linked, expected) => {
    mockResource.ChatCompletion.url = linked;
    expect(chatCompletionBaseUrl()).toBe(expected);
  });

  it('prefers the shared preview origin over the linked URL', () => {
    mockResource.ChatCompletion.url = 'https://chat-origin.app.example.test/';
    vi.stubEnv('CHAT_COMPLETION_ORIGIN_URL', 'https://chat-origin-pr1.preview.example.test/');
    expect(chatCompletionBaseUrl()).toBe('https://chat-origin-pr1.preview.example.test');
  });
});
