import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get, post } }));

import PreviewSleepBanner from './PreviewSleepBanner';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderBanner = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={appTheme}>
        <PreviewSleepBanner />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const asleep = { asleep: true, waking: false, services: [{ label: 'chat-completion', running: 0, desired: 0 }] };
const waking = { asleep: false, waking: true, services: [{ label: 'chat-completion', running: 0, desired: 1 }] };

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('PreviewSleepBanner', () => {
  it('renders nothing and does not retry when the route 404s off-preview', async () => {
    get.mockRejectedValue(Object.assign(new Error('Not found'), { response: { status: 404 } }));
    renderBanner();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('preview-sleep-banner')).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when the preview is awake', async () => {
    get.mockResolvedValue({ data: { asleep: false, waking: false, services: [] } });
    renderBanner();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByTestId('preview-sleep-banner')).toBeNull();
  });

  it('offers a wake when asleep, POSTs it, then shows progress', async () => {
    get.mockResolvedValueOnce({ data: asleep }).mockResolvedValue({ data: waking });
    post.mockResolvedValue({ data: { waking: true } });
    renderBanner();
    fireEvent.click(await screen.findByTestId('preview-sleep-wake-btn'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/preview-sleep'));
    await waitFor(() =>
      expect(screen.getByTestId('preview-sleep-banner').textContent).toContain('chat-completion 0/1')
    );
    expect(screen.queryByTestId('preview-sleep-wake-btn')).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
