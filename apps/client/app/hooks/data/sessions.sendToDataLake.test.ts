import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ISessionDocument } from '@bike4mind/common';

// getChatMessages is the only sessionsAPICalls export this hook touches; keep the
// rest of the (heavy, api-backed) module real via importOriginal.
const { mockGetChatMessages } = vi.hoisted(() => ({ mockGetChatMessages: vi.fn() }));
vi.mock('@client/app/utils/sessionsAPICalls', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/utils/sessionsAPICalls')>()),
  getChatMessages: mockGetChatMessages,
}));

const { mockOpen } = vi.hoisted(() => ({ mockOpen: vi.fn() }));
vi.mock('@client/app/stores/useSendToDataLakeStore', () => ({
  useSendToDataLakeStore: (selector: (s: { open: typeof mockOpen }) => unknown) => selector({ open: mockOpen }),
}));

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }));
vi.mock('sonner', () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));

import { useSendSessionToDataLake } from './sessions';

const session = { id: 's1', name: 'My Chat' } as ISessionDocument;

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return { Wrapper };
}

describe('useSendSessionToDataLake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('grooms the whole session to markdown and opens the Data Lake modal with session-level metadata', async () => {
    mockGetChatMessages.mockResolvedValue({
      data: [
        { prompt: 'Hello', replies: ['Hi there'] },
        { prompt: 'Second question', replies: ['First reply', 'Second reply'] },
      ],
    });

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useSendSessionToDataLake(), { wrapper: Wrapper });

    result.current.mutate(session);

    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));

    // Pulls the full session (not a single reply).
    expect(mockGetChatMessages).toHaveBeenCalledWith('s1', { all: true });

    const payload = mockOpen.mock.calls[0][0];
    expect(payload.fileName).toBe('My Chat.md');
    expect(payload.mimeType).toBe('text/markdown');
    expect(payload.sourceLabel).toBe('session');
    // Every prompt and every reply in the session is included in the markdown.
    expect(payload.content).toContain('# My Chat');
    expect(payload.content).toContain('**User:** Hello');
    expect(payload.content).toContain('**AI:** Hi there');
    expect(payload.content).toContain('**User:** Second question');
    expect(payload.content).toContain('**AI:** First reply');
    expect(payload.content).toContain('**AI:** Second reply');
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('sanitizes filesystem-hostile characters out of the session-derived filename', async () => {
    mockGetChatMessages.mockResolvedValue({ data: [{ prompt: 'Q', replies: ['A'] }] });

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useSendSessionToDataLake(), { wrapper: Wrapper });

    result.current.mutate({ id: 's2', name: 'Bug: /api/foo broke?' } as ISessionDocument);

    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
    const { fileName } = mockOpen.mock.calls[0][0];
    // Path separators and reserved chars are replaced (with '-'), never passed through to the S3 key.
    expect(fileName).not.toMatch(/[/\\:*?"<>|]/);
    expect(fileName).toBe('Bug- -api-foo broke-.md');
  });

  it('emits the User line and divider for a quest with no replies', async () => {
    mockGetChatMessages.mockResolvedValue({ data: [{ prompt: 'Lonely prompt', replies: [] }] });

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useSendSessionToDataLake(), { wrapper: Wrapper });

    result.current.mutate(session);

    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
    const { content } = mockOpen.mock.calls[0][0];
    expect(content).toContain('**User:** Lonely prompt');
    expect(content).toContain('---');
    // No AI line is emitted when the quest has zero replies.
    expect(content).not.toContain('**AI:**');
  });

  it('toasts and does not open the modal when the session fetch fails', async () => {
    mockGetChatMessages.mockRejectedValue(new Error('network'));

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useSendSessionToDataLake(), { wrapper: Wrapper });

    result.current.mutate(session);

    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    expect(mockOpen).not.toHaveBeenCalled();
  });
});
