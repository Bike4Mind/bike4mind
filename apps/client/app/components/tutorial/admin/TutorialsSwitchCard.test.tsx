import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

const current = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const mockMutate = vi.fn();
vi.mock('@client/app/hooks/tutorials/useTutorialsSwitch', () => ({
  useTutorialsSwitch: () => current.value,
  useSetTutorialsSwitch: () => ({ mutate: mockMutate, isPending: false }),
}));

import TutorialsSwitchCard from './TutorialsSwitchCard';

const BASE = '/api/test-tutorials';
const appTheme = extendTheme({ ...getThemeConfig() });
const renderCard = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <TutorialsSwitchCard apiBase={BASE} />
    </CssVarsProvider>
  );

const switchInput = () => screen.getByTestId('tutorials-switch') as HTMLInputElement;

describe('TutorialsSwitchCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    current.value = { data: false, isLoading: false, isError: false };
  });

  it('shows the switch on when the setting is on', () => {
    current.value = { data: true, isLoading: false, isError: false };
    renderCard();
    expect(screen.getByTestId('tutorials-switch-card')).toBeInTheDocument();
    expect(switchInput().checked).toBe(true);
  });

  it('shows the switch off when the setting is off', () => {
    renderCard();
    expect(switchInput().checked).toBe(false);
  });

  it('saves the toggled value on click', () => {
    renderCard();
    fireEvent.click(switchInput());
    expect(mockMutate).toHaveBeenCalledWith(true);
  });

  it('saves false when switched off', () => {
    current.value = { data: true, isLoading: false, isError: false };
    renderCard();
    fireEvent.click(switchInput());
    expect(mockMutate).toHaveBeenCalledWith(false);
  });

  it('says so and disables the switch when the read fails', () => {
    current.value = { data: undefined, isLoading: false, isError: true };
    renderCard();
    expect(screen.getByText('Could not read the tutorials switch.')).toBeInTheDocument();
    expect(switchInput().disabled).toBe(true);
  });
});
