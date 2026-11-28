import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { UseVoiceSessionEngine } from './useVoiceSessionEngine';
import VoiceInlineButton from './VoiceInlineIndicator';

const appTheme = extendTheme({ ...getThemeConfig() });
const DarkWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider
    theme={appTheme}
    defaultMode="dark"
    modeStorageKey="voice-inline-dark"
    colorSchemeStorageKey="voice-inline-dark-scheme"
  >
    {children}
  </CssVarsProvider>
);

// Only the fields VoiceInlineButton reads.
const engine = (overrides: Partial<UseVoiceSessionEngine> = {}) =>
  ({
    connectionStatus: 'disconnected',
    isEnding: false,
    isActive: false,
    isMuted: false,
    connect: vi.fn(() => Promise.resolve()),
    endSession: vi.fn(),
    ...overrides,
  }) as unknown as UseVoiceSessionEngine;

const fill = () => getComputedStyle(screen.getByTestId('voice-chat-btn')).backgroundColor;

describe('VoiceInlineButton - dark composer action fill', () => {
  // Idle, it holds the composer's action slot, so it matches the send button (composerActionSx.ts).
  it('fills the idle button with the dark accent', () => {
    render(<VoiceInlineButton engine={engine()} onOpenDebugPanel={vi.fn()} />, { wrapper: DarkWrapper });
    expect(fill()).toBe('var(--joy-palette-reading-accent)');
  });

  it('keeps the status color once the session is connected', () => {
    render(
      <VoiceInlineButton
        engine={engine({ connectionStatus: 'connected', isActive: true })}
        onOpenDebugPanel={vi.fn()}
      />,
      {
        wrapper: DarkWrapper,
      }
    );
    expect(fill()).not.toBe('var(--joy-palette-reading-accent)');
  });
});
