import { afterEach, describe, expect, it, vi } from 'vitest';

// Mutable so each test can present the ALB shape (.url) or the Cloud Map shape (.service).
const mockResource = vi.hoisted(() => ({ ChatCompletion: {} as { url?: string; service?: string } }));
vi.mock('sst', () => ({ Resource: mockResource }));

import { chatCompletionBaseUrl } from './chatCompletionTarget';

afterEach(() => {
  mockResource.ChatCompletion = {};
});

describe('chatCompletionBaseUrl', () => {
  it('uses the ALB url on prod/dev/self-host (loadBalancer stages)', () => {
    mockResource.ChatCompletion = { url: 'http://chat-completion.internal' };
    expect(chatCompletionBaseUrl()).toBe('http://chat-completion.internal');
  });

  it('falls back to the Cloud Map host on preview stages (no ALB url)', () => {
    mockResource.ChatCompletion = {
      service: 'ChatCompletion.pr1.bike4mind.bike4mind-previews.local',
    };
    expect(chatCompletionBaseUrl()).toBe('http://ChatCompletion.pr1.bike4mind.bike4mind-previews.local:8080');
  });

  it('throws loudly when neither url nor service is set (misconfigured stage)', () => {
    mockResource.ChatCompletion = {};
    expect(() => chatCompletionBaseUrl()).toThrow(/misconfigured/);
  });
});
