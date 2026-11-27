// @vitest-environment jsdom
import React from 'react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ getCapturedCode: vi.fn(), redeemPersonaCode: vi.fn() }));
vi.mock('./personaRedeemCode', () => h);

import PersonaRedeemPage from './redeem';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);
const renderPage = () => render(<PersonaRedeemPage />, { wrapper: TestWrapper });

const replace = vi.fn();

describe('PersonaRedeemPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', { configurable: true, value: { replace } });
  });

  it('posts the captured code and loads the app on success', async () => {
    h.getCapturedCode.mockReturnValue('abc');
    h.redeemPersonaCode.mockResolvedValue({ ok: true });

    renderPage();

    expect(screen.getByTestId('persona-redeem-progress')).toBeTruthy();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(h.redeemPersonaCode).toHaveBeenCalledTimes(1);
    expect(h.redeemPersonaCode).toHaveBeenCalledWith('abc');
  });

  it('shows the server message and stays put when the redeem fails', async () => {
    h.getCapturedCode.mockReturnValue('abc');
    h.redeemPersonaCode.mockResolvedValue({ ok: false, message: 'This browser is already signed in.' });

    renderPage();

    expect((await screen.findByTestId('persona-redeem-error')).textContent).toBe('This browser is already signed in.');
    expect(replace).not.toHaveBeenCalled();
  });

  it('explains a missing code without posting anything', () => {
    h.getCapturedCode.mockReturnValue(undefined);

    renderPage();

    expect(screen.getByTestId('persona-redeem-error').textContent).toMatch(/no code/);
    expect(h.redeemPersonaCode).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
