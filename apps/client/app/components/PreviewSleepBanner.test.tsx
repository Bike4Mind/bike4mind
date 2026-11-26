import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentType } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { get, post, tablet } = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_PREVIEW_SLEEP_ENABLED = 'true';
  return { get: vi.fn(), post: vi.fn(), tablet: { value: false } };
});
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get, post } }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsTablet: () => tablet.value }));

import PreviewSleepBanner from './PreviewSleepBanner';

type Placement = 'sidenav' | 'floating';
const appTheme = extendTheme({ ...getThemeConfig() });
// The client keeps react-query's default retries so the component's own retry:false is what is tested.
const renderBanner = (
  placement: Placement = 'sidenav',
  Banner: ComponentType<{ placement: Placement }> = PreviewSleepBanner
) => {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 }, mutations: { retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={appTheme}>
        <Banner placement={placement} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const asleep = { asleep: true, waking: false, services: [{ label: 'chat-completion', running: 0, desired: 0 }] };
const waking = { asleep: false, waking: true, services: [{ label: 'chat-completion', running: 0, desired: 1 }] };

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  tablet.value = false;
});

describe('PreviewSleepBanner', () => {
  it('never calls the route when the build is not a preview', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_PREVIEW_SLEEP_ENABLED = '';
    const { default: Banner } = await import('./PreviewSleepBanner');
    process.env.NEXT_PUBLIC_PREVIEW_SLEEP_ENABLED = 'true';
    get.mockResolvedValue({ data: asleep });
    renderBanner('sidenav', Banner);
    await new Promise(r => setTimeout(r, 20));
    expect(get).not.toHaveBeenCalled();
    expect(screen.queryByTestId('preview-sleep-banner')).toBeNull();
  });

  it('renders nothing and does not retry when the route fails', async () => {
    get.mockRejectedValue(Object.assign(new Error('Not found'), { response: { status: 404 } }));
    renderBanner();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByTestId('preview-sleep-banner')).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when the preview is awake', async () => {
    get.mockResolvedValue({ data: { asleep: false, waking: false, services: [] } });
    renderBanner();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByTestId('preview-sleep-banner')).toBeNull();
  });

  it('keeps polling while awake so a scheduled sleep reaches an open tab', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      get
        .mockResolvedValueOnce({ data: { asleep: false, waking: false, services: [] } })
        .mockResolvedValue({ data: asleep });
      renderBanner();
      await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(await screen.findByTestId('preview-sleep-banner')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
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

  it('keeps the Wake button when the status still reads asleep after a wake', async () => {
    get.mockResolvedValue({ data: asleep });
    post.mockResolvedValue({ data: { waking: true } });
    renderBanner();
    fireEvent.click(await screen.findByTestId('preview-sleep-wake-btn'));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('preview-sleep-wake-btn')).toBeTruthy();
    expect(screen.getByTestId('preview-sleep-banner').textContent).toContain('asleep');
  });

  it('says so when the wake request fails', async () => {
    get.mockResolvedValue({ data: asleep });
    post.mockRejectedValue(new Error('502'));
    renderBanner();
    fireEvent.click(await screen.findByTestId('preview-sleep-wake-btn'));
    expect(await screen.findByTestId('preview-sleep-wake-error')).toBeTruthy();
  });

  it.each([
    [false, 'sidenav', true],
    [false, 'floating', false],
    [true, 'sidenav', false],
    [true, 'floating', true],
  ] as const)('tablet=%s placement=%s renders=%s', async (isTablet, placement, renders) => {
    tablet.value = isTablet;
    get.mockResolvedValue({ data: asleep });
    renderBanner(placement);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByTestId('preview-sleep-banner') !== null).toBe(renders);
  });
});
