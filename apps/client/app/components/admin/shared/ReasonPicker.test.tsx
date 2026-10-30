import { useState, type ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it } from 'vitest';
import { ADMIN_ACTION_REASON_MAX_LENGTH, isValidAdminActionReason } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { ReasonPicker } from './ReasonPicker';
import {
  ADMIN_REASON_PRESETS,
  type AdminReasonDraft,
  EMPTY_ADMIN_REASON,
  composeAdminReason,
  isAdminReasonComplete,
  maxAdminReasonNoteLength,
} from './adminReason';

const theme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

const PRESETS = ['Spam or bot account', 'Billing correction'];

const Harness = () => {
  const [value, setValue] = useState<AdminReasonDraft>(EMPTY_ADMIN_REASON);
  return (
    <>
      <ReasonPicker presets={PRESETS} value={value} onChange={setValue} data-testid="test-reason-input" />
      <output data-testid="composed-reason">{composeAdminReason(value)}</output>
    </>
  );
};

const composedReason = () => screen.getByTestId('composed-reason').textContent;

describe('composeAdminReason', () => {
  it('uses the preset alone, the note alone, or "Preset: note" when both are given', () => {
    expect(composeAdminReason({ preset: 'Billing correction', note: '   ' })).toBe('Billing correction');
    expect(composeAdminReason({ preset: null, note: '  Manual fix  ' })).toBe('Manual fix');
    expect(composeAdminReason({ preset: 'Billing correction', note: ' ticket 42 ' })).toBe(
      'Billing correction: ticket 42'
    );
  });

  it('treats a preset alone as a complete reason and a short note alone as incomplete', () => {
    expect(isAdminReasonComplete({ preset: 'Billing correction', note: '' })).toBe(true);
    expect(isAdminReasonComplete({ preset: null, note: 'abc' })).toBe(false);
    expect(isAdminReasonComplete(EMPTY_ADMIN_REASON)).toBe(false);
  });

  it('caps the note so the composed reason never exceeds the shared maximum', () => {
    const preset = 'Billing correction';
    const note = 'x'.repeat(maxAdminReasonNoteLength(preset));
    expect(composeAdminReason({ preset, note })).toHaveLength(ADMIN_ACTION_REASON_MAX_LENGTH);
    expect(maxAdminReasonNoteLength(null)).toBe(ADMIN_ACTION_REASON_MAX_LENGTH);
  });

  it('only ships presets that satisfy the shared reason rule unchanged', () => {
    for (const preset of Object.values(ADMIN_REASON_PRESETS).flat()) {
      expect(isValidAdminActionReason(preset), preset).toBe(true);
      expect(preset.trim()).toBe(preset);
    }
  });
});

describe('ReasonPicker', () => {
  it('toggles a preset chip with aria-pressed and records the preset alone', () => {
    render(<Harness />, { wrapper: TestWrapper });
    const chip = screen.getByTestId('test-reason-input-preset-0');
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(composedReason()).toBe('Spam or bot account');
    expect(screen.getByTestId('test-reason-input-helper')).toHaveTextContent(
      'Recorded in the audit log as "Spam or bot account".'
    );

    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(composedReason()).toBe('');
  });

  it('switches presets rather than stacking them', () => {
    render(<Harness />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('test-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('test-reason-input-preset-1'));
    expect(screen.getByTestId('test-reason-input-preset-0')).toHaveAttribute('aria-pressed', 'false');
    expect(composedReason()).toBe('Billing correction');
  });

  it('combines a preset with a note and shows the combined audit string', () => {
    render(<Harness />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('test-reason-input-preset-1'));
    fireEvent.change(screen.getByTestId('test-reason-input'), { target: { value: 'ticket 42' } });

    expect(composedReason()).toBe('Billing correction: ticket 42');
    expect(screen.getByTestId('test-reason-input-helper')).toHaveTextContent(
      'Recorded in the audit log as "Billing correction: ticket 42".'
    );
  });

  it('explains the rule while the reason is incomplete and limits the note length', () => {
    render(<Harness />, { wrapper: TestWrapper });
    fireEvent.change(screen.getByTestId('test-reason-input'), { target: { value: 'abc' } });

    expect(screen.getByTestId('test-reason-input-helper')).toHaveTextContent(
      'Pick a reason or write at least 5 characters.'
    );
    expect(screen.getByTestId('test-reason-input')).toHaveAttribute(
      'maxLength',
      String(ADMIN_ACTION_REASON_MAX_LENGTH)
    );

    fireEvent.click(screen.getByTestId('test-reason-input-preset-1'));
    expect(screen.getByTestId('test-reason-input')).toHaveAttribute(
      'maxLength',
      String(maxAdminReasonNoteLength('Billing correction'))
    );
  });
});
