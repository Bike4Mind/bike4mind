import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ICallableFunctionShared } from '@bike4mind/common';

const h = vi.hoisted(() => ({ enabled: true, shared: undefined as ICallableFunctionShared[] | undefined }));

vi.mock('@client/app/hooks/data/callableFunctions', () => ({
  useCallableFunctionsEnabled: () => h.enabled,
  useSharedCallableFunctions: () => ({ data: h.shared }),
}));

import SharedFunctionsSection from './SharedFunctionsSection';

const appTheme = extendTheme({ ...getThemeConfig() });

const SHARED: ICallableFunctionShared = {
  id: 'fn-1',
  slug: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam.',
  status: 'pending_review',
  sharedVia: 'person',
  pin: { version: 5, seq: 2, pinnedAt: new Date() },
  trustLabel: 'verified',
  updatedAt: new Date(),
};

const renderSection = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SharedFunctionsSection />
    </CssVarsProvider>
  );

beforeEach(() => {
  h.enabled = true;
  h.shared = [SHARED];
});

describe('SharedFunctionsSection', () => {
  it('lists each shared function as pending review and not callable', () => {
    renderSection();
    expect(screen.getAllByTestId('shared-function-row')).toHaveLength(1);
    expect(screen.getByTestId('shared-function-status').textContent).toBe('Pending review');
    expect(screen.getByTestId('shared-function-row').textContent).toContain(
      'Shared with you, promotion 2. It cannot be called until you review it.'
    );
  });

  it('shows nothing with the setting off or nothing shared', () => {
    h.enabled = false;
    const { unmount } = renderSection();
    expect(screen.queryByTestId('shared-functions-section')).toBeNull();
    unmount();
    h.enabled = true;
    h.shared = [];
    renderSection();
    expect(screen.queryByTestId('shared-functions-section')).toBeNull();
  });
});
