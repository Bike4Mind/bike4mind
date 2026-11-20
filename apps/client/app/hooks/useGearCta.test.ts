import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  setOpen: vi.fn(),
  post: vi.fn(),
  openInNewTab: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }));
vi.mock('@client/app/components/Files/Browser', () => ({ useFileBrowser: () => ({ setOpen: h.setOpen }) }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: h.post } }));
vi.mock('@client/app/utils/externalLinks', () => ({ openInNewTab: h.openInNewTab }));

import { useGearCta } from './useGearCta';

beforeEach(() => {
  vi.clearAllMocks();
  h.post.mockResolvedValue({});
});

describe('useGearCta', () => {
  it('navigates with the query string split into search params', () => {
    const { result } = renderHook(() => useGearCta());
    result.current({ ctaAction: 'navigate:/profile?tab=published' });
    expect(h.navigate).toHaveBeenCalledWith({ to: '/profile', search: { tab: 'published' } });
  });

  it('opens the file browser for files', () => {
    const { result } = renderHook(() => useGearCta());
    result.current({ ctaAction: 'files' });
    expect(h.setOpen).toHaveBeenCalledWith(true);
  });

  it('opens external links and posts the stamp, then calls onStamped', async () => {
    const onStamped = vi.fn();
    const { result } = renderHook(() => useGearCta(onStamped));
    result.current({ ctaAction: 'external:https://docs.example.com#stamp:clidocs' });
    expect(h.openInNewTab).toHaveBeenCalledWith('https://docs.example.com');
    expect(h.post).toHaveBeenCalledWith('/api/gears/stamp', { key: 'clidocs' });
    await vi.waitFor(() => expect(onStamped).toHaveBeenCalled());
  });

  it('swallows a failed stamp', async () => {
    h.post.mockRejectedValue(new Error('nope'));
    const onStamped = vi.fn();
    const { result } = renderHook(() => useGearCta(onStamped));
    expect(() => result.current({ ctaAction: 'files#stamp:clidocs' })).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
    expect(onStamped).not.toHaveBeenCalled();
  });
});
