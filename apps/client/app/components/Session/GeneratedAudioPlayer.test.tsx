// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { GeneratedAudioPlayer } from './GeneratedAudioPlayer';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPlayer = (src: string) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <GeneratedAudioPlayer src={src} />
    </CssVarsProvider>
  );

describe('GeneratedAudioPlayer', () => {
  it('plays the clip from its source', () => {
    renderPlayer('https://cdn.test/generated/a.mp3');
    expect(screen.getByTestId('generated-audio-player').getAttribute('src')).toBe('https://cdn.test/generated/a.mp3');
    expect(screen.queryByTestId('generated-audio-unavailable')).toBeNull();
  });

  it('shows a deleted state instead of a dead player when the clip is gone', () => {
    renderPlayer('https://cdn.test/generated/a.mp3');
    fireEvent.error(screen.getByTestId('generated-audio-player'));
    expect(screen.queryByTestId('generated-audio-player')).toBeNull();
    expect(screen.getByTestId('generated-audio-unavailable').textContent).toMatch(/no longer available/);
  });

  it('tries again when handed a different clip', () => {
    const { rerender } = renderPlayer('https://cdn.test/generated/a.mp3');
    fireEvent.error(screen.getByTestId('generated-audio-player'));
    rerender(
      <CssVarsProvider theme={appTheme}>
        <GeneratedAudioPlayer src="https://cdn.test/generated/b.mp3" />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('generated-audio-player')).toBeTruthy();
  });
});
