import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioCompositionBrief, StudioCompositionResponse, StudioCompositionTemplate } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import type { LibraryPickRequest } from './useLibraryPicker';

const h = vi.hoisted(() => ({
  saved: [] as StudioCompositionBrief[],
  pick: vi.fn(),
}));

vi.mock('./useFieldAutosave', async () => {
  const { useState } = await import('react');
  return {
    useFieldAutosave: (_id: string, _field: string, initial: StudioCompositionBrief) => {
      const [value, setValue] = useState(initial);
      return {
        value,
        status: 'idle',
        set: (update: (current: StudioCompositionBrief) => StudioCompositionBrief) =>
          setValue(current => {
            const next = update(current);
            h.saved.push(next);
            return next;
          }),
      };
    },
  };
});
vi.mock('./useLibraryPicker', () => ({ useLibraryPicker: () => ({ pick: h.pick, picker: null }) }));
vi.mock('./FieldSaveStatus', () => ({ default: () => null }));
vi.mock('./LibraryThumb', () => ({
  default: ({ testId, onRemove }: { testId: string; onRemove: () => void }) => (
    <button type="button" data-testid={testId} onClick={onRemove}>
      Remove
    </button>
  ),
}));

import BriefPanel from './BriefPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const PHOTO = 'a'.repeat(24);

const renderPanel = (template: StudioCompositionTemplate, brief: StudioCompositionBrief = {}) =>
  render(<BriefPanel composition={{ id: 'c'.repeat(24), template, brief } as StudioCompositionResponse} />, {
    wrapper: TestWrapper,
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.saved = [];
});

describe('BriefPanel', () => {
  it.each<StudioCompositionTemplate>(['ad_campaign', 'explainer'])(
    'gives a %s the ad brief: idea, audience, call to action and product photo',
    template => {
      renderPanel(template);
      expect(screen.getByTestId('production-brief-summary-input')).toBeInTheDocument();
      expect(screen.getByTestId('production-brief-audience-input')).toBeInTheDocument();
      expect(screen.getByTestId('production-brief-callToAction-input')).toBeInTheDocument();
      expect(screen.getByTestId('production-brief-product-photo-btn')).toBeInTheDocument();
      expect(screen.queryByTestId('production-brief-tone-input')).not.toBeInTheDocument();
      expect(screen.getByText('The idea')).toBeInTheDocument();
    }
  );

  it('gives a short film its premise and tone, without a call to action or product photo', () => {
    renderPanel('short_film', { summary: 'A keeper', tone: 'wistful' });
    expect(screen.getByText('Premise')).toBeInTheDocument();
    expect(screen.getByTestId('production-brief-summary-input')).toHaveValue('A keeper');
    expect(screen.getByTestId('production-brief-tone-input')).toHaveValue('wistful');
    expect(screen.queryByTestId('production-brief-audience-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('production-brief-callToAction-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('production-brief-product-photo-btn')).not.toBeInTheDocument();
  });

  it('saves a short film tone as it is typed and drops it when cleared', () => {
    renderPanel('short_film', { summary: 'A keeper' });
    fireEvent.change(screen.getByTestId('production-brief-tone-input'), { target: { value: 'tense' } });
    expect(h.saved.at(-1)).toEqual({ summary: 'A keeper', tone: 'tense' });
    fireEvent.change(screen.getByTestId('production-brief-tone-input'), { target: { value: '' } });
    expect(h.saved.at(-1)).toEqual({ summary: 'A keeper' });
  });

  it('picks, replaces and removes an ad product photo from the Library', () => {
    renderPanel('ad_campaign');
    expect(screen.getByTestId('production-brief-product-photo-btn')).toHaveTextContent('Choose from Library');
    fireEvent.click(screen.getByTestId('production-brief-product-photo-btn'));
    const request: LibraryPickRequest = h.pick.mock.calls[0][0];
    expect(request.filter).toEqual({ mode: 'locked', type: 'image' });

    act(() => request.onPicked([]));
    expect(h.saved).toEqual([]);
    act(() => request.onPicked([{ id: PHOTO } as never]));
    expect(h.saved.at(-1)).toEqual({ productFileId: PHOTO });
    expect(screen.getByTestId('production-brief-product-photo-btn')).toHaveTextContent('Replace');

    fireEvent.click(screen.getByTestId('production-brief-product-photo'));
    expect(h.saved.at(-1)).toEqual({});
  });
});
