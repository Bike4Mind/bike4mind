import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useHelpFeedback } from './useHelpAnalytics';

const h = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: h.post } }));

let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  queryClient = new QueryClient();
  queryClient.setQueryData(['appVersion'], { version: '1.2.3' });
  h.post.mockReset();
  h.post.mockResolvedValue({ data: { success: true } });
});

describe('useHelpFeedback', () => {
  it('sends the web client context with an article rating', async () => {
    const { result } = renderHook(() => useHelpFeedback(), { wrapper });

    result.current.submitFeedback.mutate({ slug: 'getting-started', rating: 'helpful', comment: 'nice' });

    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    const [url, payload] = h.post.mock.calls[0];
    expect(url).toBe('/api/help/feedback');
    expect(payload).toMatchObject({
      slug: 'getting-started',
      rating: 'helpful',
      comment: 'nice',
      clientContext: { platform: 'web', appVersion: '1.2.3', path: window.location.pathname },
    });
  });

  it('sends the web client context with a help chat rating', async () => {
    const { result } = renderHook(() => useHelpFeedback(), { wrapper });

    result.current.submitChatFeedback.mutate({ chatQuestion: 'q', chatAnswer: 'a', rating: 'not_helpful' });

    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    const [url, payload] = h.post.mock.calls[0];
    expect(url).toBe('/api/help/chat-feedback');
    expect(payload).toMatchObject({
      chatQuestion: 'q',
      rating: 'not_helpful',
      clientContext: { platform: 'web', appVersion: '1.2.3' },
    });
  });
});
