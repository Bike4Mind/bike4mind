import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { CALLABLE_FUNCTION_DATA_LIMITS, type ICallableFunctionPublic } from '@bike4mind/common';

type Callbacks = { onSuccess?: () => void; onError?: (error: unknown) => void };

const h = vi.hoisted(() => ({
  pin: { mutate: vi.fn(), isPending: false },
  unpin: { mutate: vi.fn(), isPending: false },
  toastError: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
vi.mock('sonner', () => ({ toast: { error: h.toastError } }));
vi.mock('@client/app/hooks/data/callableFunctions', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/callableFunctions')>()),
  usePinCallableFunctionData: () => h.pin,
  useUnpinCallableFunctionData: () => h.unpin,
}));

import FunctionDataSection from '../FunctionDataSection';

const appTheme = extendTheme({ ...getThemeConfig() });

const pinOf = (name: string) => ({
  name,
  sha256: 'a'.repeat(64),
  bytes: 2048,
  sourceFileId: 'file1',
  pinnedAt: new Date(0).toISOString(),
});

const toolWith = (count: number) =>
  ({
    id: 'fn1',
    dataPins: Array.from({ length: count }, (_, i) => pinOf(`file${i}.csv`)),
  }) as unknown as ICallableFunctionPublic;

const renderSection = (tool: ICallableFunctionPublic) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <FunctionDataSection tool={tool} />
    </CssVarsProvider>
  );

const fill = (fileId: string, name: string) => {
  fireEvent.change(screen.getByTestId('python-function-data-file-id'), { target: { value: fileId } });
  fireEvent.change(screen.getByTestId('python-function-data-name'), { target: { value: name } });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.pin.isPending = false;
  h.unpin.isPending = false;
});

describe('FunctionDataSection', () => {
  it('pins a file under the trimmed name and clears the form once it succeeds', () => {
    h.pin.mutate.mockImplementation((_vars: unknown, callbacks: Callbacks) => callbacks.onSuccess?.());
    renderSection(toolWith(0));
    fill(' file9 ', ' points.csv ');
    fireEvent.click(screen.getByTestId('python-function-data-pin-btn'));

    expect(h.pin.mutate).toHaveBeenCalledWith(
      { id: 'fn1', fileId: 'file9', name: 'points.csv' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
    expect(screen.getByTestId('python-function-data-file-id')).toHaveValue('');
    expect(screen.getByTestId('python-function-data-name')).toHaveValue('');
  });

  it('keeps the form and shows the server message when pinning fails', () => {
    const refusal = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { status: 400, data: { error: 'Only a file you uploaded can be pinned.' } },
    });
    h.pin.mutate.mockImplementation((_vars: unknown, callbacks: Callbacks) => callbacks.onError?.(refusal));
    renderSection(toolWith(0));
    fill('file9', 'points.csv');
    fireEvent.click(screen.getByTestId('python-function-data-pin-btn'));

    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('python-function-data-name')).toHaveValue('points.csv');
  });

  it('unpins the file whose button is pressed', () => {
    renderSection(toolWith(2));
    fireEvent.click(screen.getAllByTestId('python-function-data-unpin-btn')[1]!);
    expect(h.unpin.mutate).toHaveBeenCalledWith({ id: 'fn1', name: 'file1.csv' }, expect.anything());
  });

  it('disables pinning at the file limit and while the form is incomplete', () => {
    const { unmount } = renderSection(toolWith(0));
    expect(screen.getByTestId('python-function-data-pin-btn')).toBeDisabled();
    fill('file9', 'points.csv');
    expect(screen.getByTestId('python-function-data-pin-btn')).not.toBeDisabled();
    unmount();

    renderSection(toolWith(CALLABLE_FUNCTION_DATA_LIMITS.maxPins));
    fill('file9', 'points.csv');
    expect(screen.getByTestId('python-function-data-pin-btn')).toBeDisabled();
    expect(screen.getAllByTestId('python-function-data-pin')).toHaveLength(CALLABLE_FUNCTION_DATA_LIMITS.maxPins);
  });

  it('keeps pinning open when sources fill their own count', () => {
    const sources = Array.from({ length: CALLABLE_FUNCTION_DATA_LIMITS.maxSources }, (_, i) => ({ name: `s${i}.csv` }));
    renderSection({ ...toolWith(1), sources } as unknown as ICallableFunctionPublic);
    fill('file9', 'points.csv');
    expect(screen.getByTestId('python-function-data-pin-btn')).not.toBeDisabled();
  });
});
