import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { MAX_EMAIL_RECIPIENTS, MAX_EMAIL_RECIPIENTS_ERROR } from '@client/types/api';
import { useSendNotebooksEmail } from './notebooks';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn() } }));

const post = api.post as unknown as Mock;

const renderSend = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useSendNotebooksEmail(), { wrapper }).result;
};

const request = (count: number) => ({
  type: 'notebooks' as const,
  sessionIds: ['s1'],
  format: 'markdown' as const,
  recipients: Array.from({ length: count }, (_, i) => `u${i}@example.com`),
});

describe('useSendNotebooksEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    post.mockResolvedValue({ data: { success: true, message: 'sent' } });
  });

  it('refuses more recipients than the server accepts without calling the API', async () => {
    const result = renderSend();
    await expect(result.current.mutateAsync(request(MAX_EMAIL_RECIPIENTS + 1))).rejects.toThrow(
      MAX_EMAIL_RECIPIENTS_ERROR
    );
    expect(post).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(MAX_EMAIL_RECIPIENTS_ERROR);
  });

  it('sends a recipient list at the maximum', async () => {
    const result = renderSend();
    await result.current.mutateAsync(request(MAX_EMAIL_RECIPIENTS));
    expect(post).toHaveBeenCalledWith('/api/email/send', expect.objectContaining({ type: 'notebooks' }));
    expect(post.mock.calls[0][1].recipients).toHaveLength(MAX_EMAIL_RECIPIENTS);
  });
});
