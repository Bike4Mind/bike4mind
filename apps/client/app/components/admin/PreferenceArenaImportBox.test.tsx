import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import PreferenceArenaImportBox from './PreferenceArenaImportBox';

const state = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock('@client/app/hooks/data/preferenceArena', () => ({
  useImportArenaPairs: () => ({ mutate: state.mutate, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const theme = extendTheme({ ...getThemeConfig() });
const renderBox = () =>
  render(
    <CssVarsProvider theme={theme}>
      <PreferenceArenaImportBox />
    </CssVarsProvider>
  );

const submit = (value: string) => {
  fireEvent.change(screen.getByTestId('arena-import-input'), { target: { value } });
  fireEvent.click(screen.getByTestId('arena-import-submit-btn'));
};

const validPair = {
  prompt: 'Explain tides',
  taskType: 'qa',
  source: 'synthetic',
  answers: [
    { modelId: 'model-one', text: 'Moon pull' },
    { modelId: 'model-two', text: 'Wind' },
  ],
};

describe('PreferenceArenaImportBox', () => {
  beforeEach(() => {
    state.mutate.mockReset();
  });

  it('rejects invalid JSON without posting', () => {
    renderBox();
    submit('[{"prompt":');
    expect(screen.getByTestId('arena-import-errors')).toHaveTextContent('Invalid JSON');
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it('rejects a schema violation without posting', () => {
    renderBox();
    submit(JSON.stringify([{ ...validPair, source: 'scraped' }]));
    expect(screen.getByTestId('arena-import-errors')).toHaveTextContent('source');
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it('accepts an object wrapping the pairs array', () => {
    renderBox();
    submit(JSON.stringify({ pairs: [validPair] }));
    expect(state.mutate).toHaveBeenCalledWith([validPair], expect.any(Object));
  });

  it('posts the validated pairs', () => {
    renderBox();
    submit(JSON.stringify([validPair]));
    expect(screen.queryByTestId('arena-import-errors')).not.toBeInTheDocument();
    expect(state.mutate).toHaveBeenCalledWith([validPair], expect.any(Object));
  });
});
