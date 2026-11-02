import { describe, it, expect, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import { Toaster } from 'sonner';
import type { TFunction } from 'i18next';

vi.mock('../components/ExpiredSession', () => ({ default: () => null }));
vi.mock('@client/app/hooks/data/user', () => ({ useGetIdentify: () => ({}) }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn() },
  isPublicPath: () => false,
  getAxiosErrorStatus: () => undefined,
}));

import { useAtlassianReconnectToast } from './UserContext';

const MESSAGE = 'Your Atlassian connection has expired.';
const t = ((key: string) => (key === 'integrations.atlassian.reconnect_required' ? MESSAGE : key)) as TFunction;

describe('useAtlassianReconnectToast', () => {
  it('shows one toast when the status flickers away and back while it is still up', async () => {
    render(<Toaster />);
    const { rerender } = renderHook(({ status }) => useAtlassianReconnectToast(status, t), {
      initialProps: { status: 'needs_reconnect' as string | undefined },
    });
    await act(async () => rerender({ status: undefined }));
    await act(async () => rerender({ status: 'needs_reconnect' }));

    expect(await screen.findAllByText(MESSAGE)).toHaveLength(1);
  });

  it('shows nothing while the connection is healthy', async () => {
    render(<Toaster />);
    renderHook(() => useAtlassianReconnectToast('connected', t));
    await act(async () => {});
    expect(screen.queryByText(MESSAGE)).toBeNull();
  });
});
