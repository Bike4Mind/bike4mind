import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy/styles';
import { ClientOutdatedBanner } from './ClientOutdatedBanner';
import { useClientOutdatedStore } from '../stores/useClientOutdatedStore';

const TestWrapper = ({ children }: { children: React.ReactNode }) => <CssVarsProvider>{children}</CssVarsProvider>;

const renderBanner = () => render(<ClientOutdatedBanner />, { wrapper: TestWrapper });

describe('ClientOutdatedBanner', () => {
  beforeEach(() => useClientOutdatedStore.setState({ outdated: false }));

  it('renders nothing while the page load is current', () => {
    renderBanner();
    expect(screen.queryByTestId('client-outdated-banner')).toBeNull();
  });

  it('appears once the store reports the client is outdated', () => {
    renderBanner();

    act(() => useClientOutdatedStore.getState().markOutdated());

    expect(screen.getByTestId('client-outdated-banner')).toBeTruthy();
  });

  it('reloads the page from the banner button', () => {
    const originalLocation = window.location;
    const reload = vi.fn();
    // jsdom's location.reload is non-configurable, so spyOn cannot wrap it.
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload } });

    try {
      renderBanner();
      act(() => useClientOutdatedStore.getState().markOutdated());

      fireEvent.click(screen.getByTestId('client-outdated-reload-btn'));

      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    }
  });
});
