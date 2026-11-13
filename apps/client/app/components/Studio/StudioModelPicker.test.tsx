import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import StudioModelPicker from './StudioModelPicker';
import type { StudioModelCard } from './studioModelCard';

const appTheme = extendTheme({ ...getThemeConfig() });

const card = (id: string, overrides: Partial<StudioModelCard> = {}): StudioModelCard => ({
  id,
  name: `Model ${id.toUpperCase()}`,
  provider: 'Acme',
  strength: `Strength of ${id}.`,
  creditsPerOutput: 10,
  outputNoun: 'image',
  modes: ['Generate'],
  pickedFor: `focus ${id}`,
  whyNotCode: null,
  unavailableReason: null,
  mismatchReason: null,
  ...overrides,
});

// Ranked order: six that fit, then a mismatch and an unavailable one from another provider.
const CARDS: StudioModelCard[] = [
  card('a', { pickedFor: 'product photoreal + reference' }),
  card('b'),
  card('c'),
  card('d'),
  card('e'),
  card('f'),
  card('g', {
    provider: 'Globex',
    pickedFor: null,
    whyNotCode: 'unsupported_aspect_ratio',
    mismatchReason: 'Model G takes no aspect ratio.',
  }),
  card('h', {
    provider: 'Globex',
    pickedFor: null,
    whyNotCode: 'model_unavailable',
    unavailableReason: 'Temporarily unavailable in Studio.',
  }),
];

const renderPicker = (selectedId = 'a', cards: StudioModelCard[] = CARDS) => {
  const onSelect = vi.fn();
  render(
    <CssVarsProvider theme={appTheme}>
      <StudioModelPicker testIdPrefix="pick" cards={cards} selectedId={selectedId} onSelect={onSelect} />
    </CssVarsProvider>
  );
  return onSelect;
};

const optionIds = () =>
  within(screen.getByTestId('pick-model-panel'))
    .queryAllByTestId(/^pick-model-option-[a-z]+$/)
    .map(element => element.getAttribute('data-testid')?.replace('pick-model-option-', ''));

describe('StudioModelPicker', () => {
  it('shows the picked model as one compact row with its picked-for line, and no list until Change', () => {
    renderPicker();
    expect(screen.getByTestId('pick-model-row-name')).toHaveTextContent('Model A');
    expect(screen.getByTestId('pick-model-row-picked-for')).toHaveTextContent(
      'Picked for: product photoreal + reference'
    );
    expect(screen.queryByTestId('pick-model-panel')).not.toBeInTheDocument();
  });

  it('shows the why-not reason in the row when the picked model does not fit the request', () => {
    renderPicker('g');
    expect(screen.getByTestId('pick-model-row-reason')).toHaveTextContent('takes no aspect ratio');
    expect(screen.queryByTestId('pick-model-row-picked-for')).not.toBeInTheDocument();
  });

  it('opens on the ranked shortlist with cost and reasons, and picks a model in one click', () => {
    const onSelect = renderPicker();
    fireEvent.click(screen.getByTestId('pick-model-change-btn'));
    expect(optionIds()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(screen.getByTestId('pick-model-option-a')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('pick-model-option-a-cost')).toHaveTextContent('credits per image');
    expect(screen.getByTestId('pick-model-option-b-picked-for')).toHaveTextContent('Picked for: focus b');
    fireEvent.click(screen.getByTestId('pick-model-option-c-radio'));
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('keeps the current pick in the shortlist when it ranks below the top', () => {
    renderPicker('g');
    fireEvent.click(screen.getByTestId('pick-model-change-btn'));
    expect(optionIds()).toEqual(['a', 'b', 'c', 'd', 'e', 'g']);
    expect(screen.getByTestId('pick-model-option-g')).toHaveAttribute('data-why-not-code', 'unsupported_aspect_ratio');
  });

  it('shows every model on "Show all", with search and a provider filter', () => {
    renderPicker();
    fireEvent.click(screen.getByTestId('pick-model-change-btn'));
    fireEvent.click(screen.getByTestId('pick-model-show-all-btn'));
    expect(optionIds()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(screen.getByTestId('pick-model-option-h-radio')).toBeDisabled();
    expect(screen.getByTestId('pick-model-option-h-reason')).toHaveTextContent('Temporarily unavailable');

    fireEvent.change(screen.getByTestId('pick-model-search-input'), { target: { value: 'strength of f' } });
    expect(optionIds()).toEqual(['f']);
    fireEvent.change(screen.getByTestId('pick-model-search-input'), { target: { value: 'nothing like it' } });
    expect(screen.getByTestId('pick-model-no-match')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('pick-model-search-input'), { target: { value: '' } });

    fireEvent.click(screen.getByTestId('pick-model-provider-select'));
    fireEvent.click(screen.getByRole('option', { name: 'Globex' }));
    expect(optionIds()).toEqual(['g', 'h']);
  });

  it('offers no "Show all" when the shortlist already holds every model', () => {
    renderPicker('a', CARDS.slice(0, 3));
    fireEvent.click(screen.getByTestId('pick-model-change-btn'));
    expect(optionIds()).toEqual(['a', 'b', 'c']);
    expect(screen.queryByTestId('pick-model-show-all-btn')).not.toBeInTheDocument();
  });
});
