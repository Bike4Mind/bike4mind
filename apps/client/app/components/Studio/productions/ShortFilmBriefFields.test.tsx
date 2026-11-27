// @vitest-environment jsdom
import { useEffect, useState, type ReactNode } from 'react';
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ShortFilmBriefFields, {
  initialShortFilmBrief,
  shortFilmCreateFields,
  type ShortFilmBrief,
} from './ShortFilmBriefFields';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const seen = { latest: initialShortFilmBrief() };
const Harness = ({ initial }: { initial?: ShortFilmBrief }) => {
  const [value, setValue] = useState(initial ?? initialShortFilmBrief());
  useEffect(() => {
    seen.latest = value;
  });
  return <ShortFilmBriefFields value={value} onChange={setValue} />;
};
const renderFields = (initial?: ShortFilmBrief) =>
  render(
    <TestWrapper>
      <Harness initial={initial} />
    </TestWrapper>
  );

describe('ShortFilmBriefFields', () => {
  it('keeps the outputs in the canonical order whatever order they are ticked in', () => {
    renderFields({ ...initialShortFilmBrief(), aspects: [] });
    expect(screen.getByTestId('productions-short-film-aspects-error')).toBeTruthy();
    fireEvent.click(screen.getByTestId('productions-short-film-aspect-1x1-checkbox'));
    fireEvent.click(screen.getByTestId('productions-short-film-aspect-16x9-checkbox'));
    expect(seen.latest.aspects).toEqual(['16:9', '1:1']);
    expect(screen.queryByTestId('productions-short-film-aspects-error')).toBeNull();
  });

  it('switches the length and ignores a click on the selected one', () => {
    renderFields();
    fireEvent.click(screen.getByTestId('productions-short-film-length-90s'));
    expect(seen.latest.durationMs).toBe(90_000);
    fireEvent.click(screen.getByTestId('productions-short-film-length-90s'));
    expect(seen.latest.durationMs).toBe(90_000);
  });

  it('edits the premise and tone', () => {
    renderFields();
    fireEvent.change(screen.getByTestId('productions-short-film-premise-input'), { target: { value: 'A lighthouse' } });
    fireEvent.change(screen.getByTestId('productions-short-film-tone-input'), { target: { value: 'Quiet' } });
    expect(seen.latest.premise).toBe('A lighthouse');
    expect(seen.latest.tone).toBe('Quiet');
  });
});

describe('shortFilmCreateFields', () => {
  it('leaves out empty text fields', () => {
    const { brief } = shortFilmCreateFields({ ...initialShortFilmBrief(), premise: '  ', tone: '' });
    expect(brief).toEqual({});
  });

  it('trims the text and sizes the timeline', () => {
    const { brief, timeline } = shortFilmCreateFields({
      premise: ' A lighthouse ',
      tone: ' Quiet ',
      durationMs: 30_000,
      aspects: ['9:16'],
    });
    expect(brief).toEqual({ summary: 'A lighthouse', tone: 'Quiet' });
    expect(timeline.durationMs).toBe(30_000);
  });
});
