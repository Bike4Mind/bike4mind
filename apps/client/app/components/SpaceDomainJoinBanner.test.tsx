import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  enabled: true,
  suggestions: [] as Array<{ spaceId: string; spaceName: string }>,
  join: vi.fn(),
  suggestionsEnabledArg: undefined as boolean | undefined,
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: unknown) => unknown) => selector({ currentUser: { id: 'me', emailVerified: true } }),
}));
vi.mock('@client/app/hooks/useSpacesEnabled', () => ({
  useSpacesEnabled: () => ({ enabled: h.enabled, ready: true }),
}));
vi.mock('@client/app/hooks/data/spaces', () => ({
  useSpaceDomainSuggestions: (enabled: boolean) => {
    h.suggestionsEnabledArg = enabled;
    return { data: enabled ? h.suggestions : undefined };
  },
  useJoinSpaceViaDomain: () => ({ mutate: h.join, isPending: false, isError: false }),
}));

import SpaceDomainJoinBanner from './SpaceDomainJoinBanner';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderBanner = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SpaceDomainJoinBanner />
    </CssVarsProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.enabled = true;
  h.suggestions = [{ spaceId: 's1', spaceName: 'Guild' }];
});

describe('SpaceDomainJoinBanner', () => {
  it('offers the suggested Space and joins it', () => {
    renderBanner();
    expect(screen.getByTestId('space-domain-join-banner')).toHaveTextContent('Guild');
    fireEvent.click(screen.getByTestId('space-domain-join-btn'));
    expect(h.join).toHaveBeenCalledWith('s1');
  });

  it('renders nothing and asks for nothing with the flag off', () => {
    h.enabled = false;
    renderBanner();
    expect(screen.queryByTestId('space-domain-join-banner')).not.toBeInTheDocument();
    expect(h.suggestionsEnabledArg).toBe(false);
  });

  it('stays dismissed for that user', () => {
    const { unmount } = renderBanner();
    fireEvent.click(screen.getByTestId('space-domain-join-dismiss-btn'));
    expect(screen.queryByTestId('space-domain-join-banner')).not.toBeInTheDocument();
    unmount();
    renderBanner();
    expect(screen.queryByTestId('space-domain-join-banner')).not.toBeInTheDocument();
  });
});
