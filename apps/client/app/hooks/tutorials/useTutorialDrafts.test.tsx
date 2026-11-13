import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockPost = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mockPost, get: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { tutorialDraftsKey } from '@client/app/components/tutorial/tutorialKeys';
import { TutorialDraftRefused, useTutorialDraftAction } from './useTutorialDrafts';

const BASE = '/api/test-tutorials';

function setup() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { invalidate, ...renderHook(() => useTutorialDraftAction(BASE), { wrapper }) };
}

const refusal = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });

describe('useTutorialDraftAction', () => {
  it('maps a 4xx to TutorialDraftRefused with its message, rules and code', async () => {
    mockPost.mockRejectedValue(
      refusal(422, { error: 'Fix every rule', code: 'X', rules: [{ rule: 'r', message: 'm' }] })
    );
    const { result, invalidate } = setup();
    result.current.mutate({ action: 'approve', moduleId: 'a' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(TutorialDraftRefused);
    expect(result.current.error).toMatchObject({ message: 'Fix every rule', code: 'X', rules: [{ rule: 'r' }] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: tutorialDraftsKey(BASE) });
  });

  it('refetches the drafts when the write was STALE', async () => {
    mockPost.mockRejectedValue(refusal(409, { error: 'The draft changed', code: 'STALE' }));
    const { result, invalidate } = setup();
    result.current.mutate({ action: 'save', moduleId: 'a' });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: tutorialDraftsKey(BASE) }));
  });

  it('rethrows a non-4xx error unchanged', async () => {
    const boom = new Error('network');
    mockPost.mockRejectedValue(boom);
    const { result } = setup();
    result.current.mutate({ action: 'save', moduleId: 'a' });
    await waitFor(() => expect(result.current.error).toBe(boom));
  });
});
