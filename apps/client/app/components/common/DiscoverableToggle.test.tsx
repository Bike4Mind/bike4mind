import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { DiscoverableToggle } from './DiscoverableToggle';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn().mockResolvedValue({ data: {} }), delete: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { api } from '@client/app/contexts/ApiContext';
const apiPatch = api.patch as unknown as ReturnType<typeof vi.fn>;

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderToggle = (props: Partial<React.ComponentProps<typeof DiscoverableToggle>> = {}) =>
  render(
    <Wrapper>
      <DiscoverableToggle publicId="pub-1" initialDiscoverable={false} isOpenPublic {...props} />
    </Wrapper>
  );

const toggle = () => screen.getByTestId('discoverable-toggle') as HTMLInputElement;

beforeEach(() => {
  apiPatch.mockReset().mockResolvedValue({ data: {} });
});

describe('DiscoverableToggle', () => {
  it('renders nothing when the artifact is not open-public', () => {
    renderToggle({ isOpenPublic: false });
    expect(screen.queryByTestId('discoverable-toggle')).toBeNull();
  });

  it('reflects the stored value', () => {
    renderToggle({ initialDiscoverable: true });
    expect(toggle().checked).toBe(true);
  });

  it('PATCHes discoverable:true when switched on', async () => {
    renderToggle();
    fireEvent.click(toggle());
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', { discoverable: true }));
  });

  it('PATCHes discoverable:false when switched off', async () => {
    renderToggle({ initialDiscoverable: true });
    fireEvent.click(toggle());
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/api/publish/artifacts/pub-1', { discoverable: false }));
  });

  it('rolls back to OFF when the opt-in request fails', async () => {
    // The dangerous direction: the UI must never show "listed" (or stay showing a
    // state the server did not accept) on a failed write.
    apiPatch.mockRejectedValueOnce(new Error('nope'));
    renderToggle();
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().checked).toBe(false));
  });

  it('rolls back to ON when the opt-OUT request fails, rather than claiming it is hidden', async () => {
    apiPatch.mockRejectedValueOnce(new Error('nope'));
    renderToggle({ initialDiscoverable: true });
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().checked).toBe(true));
  });
});
