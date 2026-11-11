import { describe, it, expect, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { useLLM } from '@client/app/contexts/LLMContext';
import { buildFeedbackClientContext } from './feedbackClientContext';

describe('buildFeedbackClientContext', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
    useLLM.setState({ model: '' });
    window.history.replaceState({}, '', '/notebooks/abc?token=secret#frag');
  });

  it('reports the route without its query string or hash', () => {
    expect(buildFeedbackClientContext(queryClient).path).toBe('/notebooks/abc');
  });

  it('reports the web platform and the window size', () => {
    expect(buildFeedbackClientContext(queryClient)).toMatchObject({
      platform: 'web',
      viewport: { width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) },
    });
  });

  it('reads the app version from the cache and omits it when the cache is cold', () => {
    expect(buildFeedbackClientContext(queryClient)).not.toHaveProperty('appVersion');

    queryClient.setQueryData(['appVersion'], { version: '4.5.6' });
    expect(buildFeedbackClientContext(queryClient).appVersion).toBe('4.5.6');
  });

  it('includes the selected model only when there is one', () => {
    expect(buildFeedbackClientContext(queryClient)).not.toHaveProperty('model');

    useLLM.setState({ model: 'some-model' });
    expect(buildFeedbackClientContext(queryClient).model).toBe('some-model');
  });
});
