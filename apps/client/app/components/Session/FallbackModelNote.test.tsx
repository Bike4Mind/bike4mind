import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { FallbackInfo } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import FallbackModelNote from './FallbackModelNote';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const fallbackInfo: FallbackInfo = {
  sessionId: 'sess-1',
  primaryModel: 'claude-opus-4-8',
  primaryModelName: 'Claude Opus 4.8',
  fallbackModel: 'gpt-5',
  fallbackModelName: 'GPT-5',
  reason: '529 overloaded',
  timestamp: 1_760_000_000_000,
};

describe('FallbackModelNote', () => {
  it('renders nothing for a turn the requested model answered', () => {
    const { container } = render(<FallbackModelNote />, { wrapper: TestWrapper });
    expect(container).toBeEmptyDOMElement();
  });

  it('names the model that answered and the one that was requested', () => {
    render(<FallbackModelNote fallbackInfo={fallbackInfo} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('fallback-model-note-chip').textContent).toBe(
      'Answered by GPT-5 - Claude Opus 4.8 was unavailable'
    );
  });
});
