import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { CALLABLE_FUNCTION_DATA_LIMITS, type ICallableFunctionPublic, type IFabFileDocument } from '@bike4mind/common';

type Callbacks = { onSuccess?: () => void; onError?: (error: unknown) => void };

const h = vi.hoisted(() => ({
  pin: { mutate: vi.fn(), isPending: false },
  unpin: { mutate: vi.fn(), isPending: false },
  toastError: vi.fn(),
  browser: { onAdd: undefined as undefined | ((files: IFabFileDocument[]) => void), labelKey: '', opened: 0 },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
vi.mock('sonner', () => ({ toast: { error: h.toastError } }));
vi.mock('@client/app/hooks/data/callableFunctions', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/callableFunctions')>()),
  usePinCallableFunctionData: () => h.pin,
  useUnpinCallableFunctionData: () => h.unpin,
}));
vi.mock('@client/app/components/Files/EmbeddedFileBrowser', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  type Props = { onAdd?: (files: IFabFileDocument[]) => void; addButtonLabelKey?: string };
  const Browser = forwardRef<{ handleOpen: () => void }, Props>(({ onAdd, addButtonLabelKey }, ref) => {
    h.browser.onAdd = onAdd;
    h.browser.labelKey = addButtonLabelKey ?? '';
    useImperativeHandle(ref, () => ({ handleOpen: () => (h.browser.opened += 1) }));
    return null;
  });
  Browser.displayName = 'EmbeddedFileBrowser';
  return { default: Browser };
});

import FunctionDataSection from '../FunctionDataSection';

const appTheme = extendTheme({ ...getThemeConfig() });

const pinOf = (name: string, bytes = 2048) => ({
  name,
  sha256: 'a'.repeat(64),
  bytes,
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

const fileOf = (id: string, fileName: string) => ({ id, fileName }) as IFabFileDocument;

const pick = (...files: IFabFileDocument[]) => {
  fireEvent.click(screen.getByTestId('python-function-data-choose-btn'));
  act(() => h.browser.onAdd?.(files));
};

const fill = (fileId: string, name: string) => {
  pick(fileOf(fileId, 'upload.csv'));
  fireEvent.change(screen.getByTestId('python-function-data-name'), { target: { value: name } });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.pin.isPending = false;
  h.unpin.isPending = false;
  h.browser.opened = 0;
});

describe('FunctionDataSection', () => {
  it("picks from the person's files with the app's file picker, not a pasted id, and names it after the file", () => {
    renderSection(toolWith(0));
    expect(screen.queryByTestId('python-function-data-file-id')).toBeNull();
    expect(screen.getByTestId('python-function-data-chosen').textContent).toBe('Choose a file');

    pick(fileOf('file9', 'Field Data (2026).csv'));
    expect(h.browser.opened).toBe(1);
    expect(h.browser.labelKey).toBe('file_browser.use_files_as_data');
    expect(screen.getByTestId('python-function-data-chosen').textContent).toBe('Field Data (2026).csv');
    expect(screen.getByTestId('python-function-data-name')).toHaveValue('Field_Data_2026_.csv');
  });

  it('keeps a name already typed, and takes only one file at a time', () => {
    renderSection(toolWith(0));
    fireEvent.change(screen.getByTestId('python-function-data-name'), { target: { value: 'rates.csv' } });
    pick(fileOf('file9', 'upload.csv'));
    expect(screen.getByTestId('python-function-data-name')).toHaveValue('rates.csv');

    pick(fileOf('file7', 'a.csv'), fileOf('file8', 'b.csv'));
    expect(h.toastError).toHaveBeenCalledWith('Pick one file at a time.');
    expect(screen.getByTestId('python-function-data-chosen').textContent).toBe('upload.csv');
  });

  it('renames to each new pick until the person edits the name, and keeps the typed name after that', () => {
    renderSection(toolWith(0));
    const nameInput = () => screen.getByTestId('python-function-data-name');
    pick(fileOf('file1', 'first.csv'));
    expect(nameInput()).toHaveValue('first.csv');
    pick(fileOf('file2', 'second run.csv'));
    expect(nameInput()).toHaveValue('second_run.csv');

    fireEvent.change(nameInput(), { target: { value: 'rates.csv' } });
    pick(fileOf('file3', 'third.csv'));
    expect(screen.getByTestId('python-function-data-chosen').textContent).toBe('third.csv');
    expect(nameInput()).toHaveValue('rates.csv');

    fireEvent.change(nameInput(), { target: { value: '' } });
    pick(fileOf('file4', 'fourth.csv'));
    expect(nameInput()).toHaveValue('fourth.csv');
  });

  it('pins the picked file under the trimmed name and clears the form once it succeeds', () => {
    h.pin.mutate.mockImplementation((_vars: unknown, callbacks: Callbacks) => callbacks.onSuccess?.());
    renderSection(toolWith(0));
    fill('file9', ' points.csv ');
    fireEvent.click(screen.getByTestId('python-function-data-pin-btn'));

    expect(h.pin.mutate).toHaveBeenCalledWith(
      { id: 'fn1', fileId: 'file9', name: 'points.csv' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
    expect(screen.getByTestId('python-function-data-chosen').textContent).toBe('Choose a file');
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
    expect(screen.getByTestId('python-function-data-chosen').textContent).toBe('upload.csv');
  });

  it('unpins the file whose button is pressed', () => {
    renderSection(toolWith(2));
    fireEvent.click(screen.getAllByTestId('python-function-data-unpin-btn')[1]!);
    expect(h.unpin.mutate).toHaveBeenCalledWith({ id: 'fn1', name: 'file1.csv' }, expect.anything());
  });

  it('shows a size under 1 KB in bytes, and larger ones in KB or MB', () => {
    const dataPins = [pinOf('one.txt', 1), pinOf('small.csv', 46), pinOf('two.csv', 2048), pinOf('big.bin', 3 << 20)];
    renderSection({ id: 'fn1', dataPins } as unknown as ICallableFunctionPublic);
    expect(screen.getAllByTestId('python-function-data-pin').map(row => row.textContent?.split(',')[0])).toEqual([
      '/data/one.txt 1 byte',
      '/data/small.csv 46 bytes',
      '/data/two.csv 2 KB',
      '/data/big.bin 3.0 MB',
    ]);
  });

  it('disables pinning at the file limit and while the form is incomplete', () => {
    const { unmount } = renderSection(toolWith(0));
    expect(screen.getByTestId('python-function-data-pin-btn')).toBeDisabled();
    fill('file9', 'points.csv');
    expect(screen.getByTestId('python-function-data-pin-btn')).not.toBeDisabled();
    unmount();

    renderSection(toolWith(CALLABLE_FUNCTION_DATA_LIMITS.maxPins));
    expect(screen.getByTestId('python-function-data-choose-btn')).toBeDisabled();
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
