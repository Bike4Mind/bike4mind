import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { MetricsInfoModal } from './MetricsInfoModal';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('MetricsInfoModal', () => {
  it('renders in the admin dialog frame and closes on Escape and the close button', () => {
    const onClose = vi.fn();
    render(
      <CssVarsProvider theme={appTheme}>
        <MetricsInfoModal open onClose={onClose} hasStreamingData={false} />
      </CssVarsProvider>
    );
    expect(screen.getByRole('dialog', { name: 'Performance metrics explained' })).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('metrics-info-modal'), { key: 'Escape' });
    fireEvent.click(screen.getByTestId('metrics-info-modal-close-btn'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
