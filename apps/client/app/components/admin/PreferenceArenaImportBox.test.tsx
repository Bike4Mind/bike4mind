import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import PreferenceArenaImportBox from './PreferenceArenaImportBox';

const state = vi.hoisted(() => ({ mutate: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn() }));

vi.mock('@client/app/hooks/data/preferenceArena', () => ({
  useImportArenaPairs: () => ({ mutateAsync: state.mutate, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: state.toastSuccess, error: state.toastError } }));

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
    state.mutate.mockImplementation(async (pairs: unknown[]) => ({ inserted: pairs.length }));
    state.toastSuccess.mockReset();
    state.toastError.mockReset();
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

  it('accepts an object wrapping the pairs array', async () => {
    renderBox();
    submit(JSON.stringify({ pairs: [validPair] }));
    await waitFor(() => expect(state.mutate).toHaveBeenCalledWith([validPair]));
  });

  it('posts the validated pairs', async () => {
    renderBox();
    submit(JSON.stringify([validPair]));
    expect(screen.queryByTestId('arena-import-errors')).not.toBeInTheDocument();
    await waitFor(() => expect(state.mutate).toHaveBeenCalledWith([validPair]));
  });

  it('sends large imports in chunks and sums the inserted counts', async () => {
    renderBox();
    submit(JSON.stringify(Array.from({ length: 120 }, () => validPair)));
    await waitFor(() => expect(state.toastSuccess).toHaveBeenCalledWith('Imported 120 pairs'));
    expect(state.mutate.mock.calls.map(([chunk]) => chunk.length)).toEqual([50, 50, 20]);
  });

  it('stops at the first failed chunk and reports what was imported', async () => {
    state.mutate.mockResolvedValueOnce({ inserted: 50 }).mockRejectedValueOnce(new Error('boom'));
    renderBox();
    submit(JSON.stringify(Array.from({ length: 120 }, () => validPair)));
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('boom (50 imported before the failure)'));
    expect(state.mutate).toHaveBeenCalledTimes(2);
    expect(state.toastSuccess).not.toHaveBeenCalled();
  });
});
