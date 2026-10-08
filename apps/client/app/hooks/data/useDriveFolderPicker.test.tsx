import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const h = vi.hoisted(() => ({
  openPicker: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  toastError: vi.fn(),
  clientId: 'gcid' as string | undefined,
  configLoaded: true,
}));

vi.mock('@client/app/hooks/data/settings', () => ({
  useConfig: () => ({ data: h.configLoaded ? { googleClientId: h.clientId } : undefined }),
}));
vi.mock('react-google-drive-picker', () => ({ default: () => [h.openPicker] }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.get, post: h.post } }));
vi.mock('sonner', () => ({ toast: { error: h.toastError } }));

import { useDriveFolderPicker } from './useDriveFolderPicker';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?state=st-1';
const realLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  h.clientId = 'gcid';
  h.configLoaded = true;
  Object.defineProperty(window, 'location', { configurable: true, value: { href: '' } });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const render = (onBeforeRedirect = vi.fn()) =>
  renderHook(() => useDriveFolderPicker({ onPicked: vi.fn(), onBeforeRedirect }));

describe('useDriveFolderPicker', () => {
  it('calls onBeforeRedirect before the /connect consent redirect (Drive never linked)', async () => {
    h.get.mockRejectedValue({ response: { status: 400 } });
    h.post.mockResolvedValue({ data: { authUrl: AUTH_URL } });
    const onBeforeRedirect = vi.fn(() => expect(window.location.href).toBe(''));
    const { result } = render(onBeforeRedirect);

    await act(() => result.current.openFolderPicker());

    expect(onBeforeRedirect).toHaveBeenCalledWith(AUTH_URL);
    expect(window.location.href).toBe(AUTH_URL);
  });

  it('calls onBeforeRedirect before the /token authUrl redirect (refresh failed)', async () => {
    h.get.mockResolvedValue({ data: { authUrl: AUTH_URL } });
    const onBeforeRedirect = vi.fn();
    const { result } = render(onBeforeRedirect);

    await act(() => result.current.openFolderPicker());

    expect(onBeforeRedirect).toHaveBeenCalledWith(AUTH_URL);
    expect(window.location.href).toBe(AUTH_URL);
  });

  it('still redirects when onBeforeRedirect throws', async () => {
    h.get.mockResolvedValue({ data: { authUrl: AUTH_URL } });
    const { result } = render(
      vi.fn(() => {
        throw new Error('storage full');
      })
    );

    await act(() => result.current.openFolderPicker());

    expect(window.location.href).toBe(AUTH_URL);
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('waits for the Picker API to load before opening the picker', async () => {
    vi.useFakeTimers();
    h.get.mockResolvedValue({ data: { accessToken: 'tok' } });
    const { result } = render();

    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.openFolderPicker();
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(h.openPicker).not.toHaveBeenCalled();

    vi.stubGlobal('google', { picker: {} });
    await act(() => vi.advanceTimersByTimeAsync(600));
    await act(() => done);

    expect(h.openPicker).toHaveBeenCalledTimes(1);
    expect(result.current.isPicking).toBe(true);
  });

  it('gives up with a toast and clears isPicking when the Picker API never loads', async () => {
    vi.useFakeTimers();
    h.get.mockResolvedValue({ data: { accessToken: 'tok' } });
    const { result } = render();

    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.openFolderPicker();
    });
    await act(() => vi.advanceTimersByTimeAsync(10_500));
    await act(() => done);

    expect(h.openPicker).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith('Google Drive is still loading. Please try again.');
    expect(result.current.isPicking).toBe(false);
  });

  it("uses the client id that loads while the token is in flight, not the first render's", async () => {
    h.clientId = undefined;
    let resolveToken: (value: { data: { accessToken: string } }) => void = () => undefined;
    h.get.mockReturnValue(new Promise(resolve => (resolveToken = resolve)));
    vi.stubGlobal('google', { picker: {} });
    const { result, rerender } = render();
    const openFromFirstRender = result.current.openFolderPicker;

    let done: Promise<void> | undefined;
    act(() => {
      done = openFromFirstRender();
    });
    h.clientId = 'gcid';
    rerender();
    resolveToken({ data: { accessToken: 'tok' } });
    await act(() => done);

    expect(h.toastError).not.toHaveBeenCalled();
    expect(h.openPicker).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'gcid' }));
  });

  it('waits for server config that is still loading after the token returns', async () => {
    vi.useFakeTimers();
    h.configLoaded = false;
    h.get.mockResolvedValue({ data: { accessToken: 'tok' } });
    vi.stubGlobal('google', { picker: {} });
    const { result, rerender } = render();

    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.openFolderPicker();
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(h.openPicker).not.toHaveBeenCalled();

    h.configLoaded = true;
    rerender();
    await act(() => vi.advanceTimersByTimeAsync(300));
    await act(() => done);

    expect(h.toastError).not.toHaveBeenCalled();
    expect(h.openPicker).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'gcid' }));
  });

  it('fails fast without polling when loaded config has no client id', async () => {
    h.clientId = undefined;
    h.get.mockResolvedValue({ data: { accessToken: 'tok' } });
    const { result } = render();

    await act(() => result.current.openFolderPicker());

    expect(h.openPicker).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith('Google Drive is unavailable right now. Please try again.');
    expect(result.current.isPicking).toBe(false);
  });
});
