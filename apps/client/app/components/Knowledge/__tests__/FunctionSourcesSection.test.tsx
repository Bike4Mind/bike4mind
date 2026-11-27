import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ICallableFunctionPublic } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  save: { mutate: vi.fn(), isPending: false },
  toastError: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
vi.mock('sonner', () => ({ toast: { error: h.toastError } }));
vi.mock('@client/app/hooks/data/callableFunctions', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/callableFunctions')>()),
  useSetCallableFunctionSources: () => h.save,
}));

import FunctionSourcesSection from '../FunctionSourcesSection';

const appTheme = extendTheme({ ...getThemeConfig() });

const RATES = { name: 'rates.csv', url: 'https://data.example.com/rates.csv', mode: 'live' as const };
const BASE = {
  name: 'base.csv',
  url: 'https://data.example.com/base.csv',
  mode: 'pinned' as const,
  pinned: { sha256: 'b'.repeat(64), bytes: 8, fetchedAt: new Date(0) },
};

const tool = (overrides: Partial<ICallableFunctionPublic> = {}): ICallableFunctionPublic =>
  ({
    id: 'fn-1',
    slug: 'rates',
    dataPins: [],
    sources: [],
    ...overrides,
  }) as unknown as ICallableFunctionPublic;

const renderSection = (value: ICallableFunctionPublic) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <FunctionSourcesSection tool={value} />
    </CssVarsProvider>
  );

const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const addButton = () => screen.getByTestId('python-function-source-add-btn');

beforeEach(() => {
  vi.clearAllMocks();
  h.save.isPending = false;
});

describe('FunctionSourcesSection', () => {
  it('adds a source after the ones already declared, and enables Add only with a name and a URL', () => {
    renderSection(tool({ sources: [BASE] as never }));
    expect(addButton()).toBeDisabled();
    type('python-function-source-url', ` ${RATES.url} `);
    expect(addButton()).toBeDisabled();
    type('python-function-source-name', RATES.name);
    expect(addButton()).not.toBeDisabled();
    fireEvent.click(addButton());
    expect(h.save.mutate).toHaveBeenCalledWith(
      {
        id: 'fn-1',
        sources: [{ name: BASE.name, url: BASE.url, mode: 'pinned' }, RATES],
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) })
    );
  });

  it('removes one source and keeps the others as declared', () => {
    renderSection(tool({ sources: [BASE, RATES] as never }));
    expect(screen.getAllByTestId('python-function-source')).toHaveLength(2);
    expect(screen.getByText(/sha256 bbbbbbbbbbbb\.\.\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove base.csv' }));
    expect(h.save.mutate).toHaveBeenCalledWith({ id: 'fn-1', sources: [RATES] }, { onError: expect.any(Function) });
  });

  it('disables Add at the source limit, whatever the data files hold', () => {
    const sources = Array.from({ length: 10 }, (_, i) => ({ ...RATES, name: `s${i}.csv` }));
    renderSection(tool({ sources: sources as never }));
    type('python-function-source-url', 'https://data.example.com/more.csv');
    type('python-function-source-name', 'more.csv');
    expect(addButton()).toBeDisabled();
  });

  it('counts the sources against their own limit, not the data files', () => {
    const dataPins = Array.from({ length: 4 }, (_, i) => ({ name: `f${i}.csv` }));
    renderSection(tool({ dataPins: dataPins as never, sources: [RATES, BASE] as never }));
    expect(screen.getByText(/2 of 10 used\./)).toBeInTheDocument();
  });

  it('keeps Add open when the data files are full, because sources have their own count', () => {
    const dataPins = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.csv` }));
    renderSection(tool({ dataPins: dataPins as never, sources: [RATES] as never }));
    type('python-function-source-url', 'https://data.example.com/more.csv');
    type('python-function-source-name', 'more.csv');
    expect(addButton()).not.toBeDisabled();
  });

  it("shows the server's refusal in a toast", () => {
    h.save.mutate.mockImplementation((_input, { onError }: { onError: (error: unknown) => void }) =>
      onError({
        isAxiosError: true,
        response: { status: 400, data: { error: 'https://data.other.example is not one of the data origins.' } },
      })
    );
    renderSection(tool());
    type('python-function-source-url', 'https://data.other.example/rates.csv');
    type('python-function-source-name', 'rates.csv');
    fireEvent.click(addButton());
    expect(h.toastError).toHaveBeenCalledWith('https://data.other.example is not one of the data origins.');
  });
});
