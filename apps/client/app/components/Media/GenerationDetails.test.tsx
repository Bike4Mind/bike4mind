import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import GenerationDetails, { formatSecondsClock, readGenerationMetadata } from './GenerationDetails';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const song = {
  generator: 'music',
  provider: 'elevenlabs',
  modelId: 'music_v2',
  jobId: 'job-1',
  prompt: 'A slow folk song about the sea',
  lyrics: '[Verse]\nThe tide comes in\nThe tide goes out',
  durationSeconds: 125.4,
};

describe('readGenerationMetadata', () => {
  it('reads the generation record', () => {
    expect(readGenerationMetadata({ sourceMetadata: { sessionId: 's1', generation: song } })).toEqual(song);
  });

  it('is undefined for a file with no record, or a record of another shape', () => {
    expect(readGenerationMetadata({})).toBeUndefined();
    expect(readGenerationMetadata({ sourceMetadata: { channel: 'C1' } })).toBeUndefined();
    expect(readGenerationMetadata({ sourceMetadata: { generation: { prompt: 'no generator' } } })).toBeUndefined();
  });
});

describe('formatSecondsClock', () => {
  it('formats minutes and zero-padded seconds', () => {
    expect(formatSecondsClock(125.4)).toBe('2:05');
    expect(formatSecondsClock(9.6)).toBe('0:10');
    expect(formatSecondsClock(59.6)).toBe('1:00');
  });
});

describe('GenerationDetails', () => {
  it('shows model, length, prompt and lyrics of a generated song', () => {
    render(<GenerationDetails file={{ sourceMetadata: { generation: song } }} />, { wrapper: Wrapper });
    expect(screen.getByTestId('generation-details-model').textContent).toBe('music_v2');
    expect(screen.getByTestId('generation-details-duration').textContent).toBe('2:05');
    expect(screen.getByTestId('generation-details-prompt').textContent).toBe(song.prompt);
    expect(screen.getByTestId('generation-details-lyrics').textContent).toBe(song.lyrics);
  });

  it('falls back to the provider when no model was reported, and omits absent fields', () => {
    render(
      <GenerationDetails
        file={{ sourceMetadata: { generation: { generator: 'speech', provider: 'openai', prompt: 'Hi' } } }}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByTestId('generation-details-model').textContent).toBe('openai');
    expect(screen.queryByTestId('generation-details-duration')).toBeNull();
    expect(screen.queryByTestId('generation-details-lyrics')).toBeNull();
  });

  it('renders nothing for a file that was not generated', () => {
    render(<GenerationDetails file={{}} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('generation-details')).toBeNull();
  });
});
