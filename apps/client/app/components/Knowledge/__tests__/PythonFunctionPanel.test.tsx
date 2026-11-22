import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { PYTHON_SCRIPT_BUSY } from '@client/app/utils/pyodideManager';

const callFunction = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/usePyodide', () => ({ usePyodide: () => ({ callFunction }) }));

const fns = vi.hoisted(() => ({
  saved: { data: null as unknown, isLoading: false },
  query: vi.fn(),
  repin: { mutate: vi.fn(), isPending: false },
  setEnabled: { mutate: vi.fn(), isPending: false },
  remove: { mutate: vi.fn(), isPending: false },
  dialog: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
vi.mock('@client/app/hooks/data/callableFunctions', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/callableFunctions')>()),
  useArtifactCallableFunction: (artifactId: string | null, version: number) => {
    fns.query(artifactId, version);
    return fns.saved;
  },
  useRepinCallableFunction: () => fns.repin,
  useSetCallableFunctionEnabled: () => fns.setEnabled,
  useDeleteCallableFunction: () => fns.remove,
}));
vi.mock('../SaveFunctionDialog', () => ({
  default: (props: Record<string, unknown>) => {
    fns.dialog(props);
    return <div data-testid="save-function-dialog" />;
  },
}));
vi.mock('sonner', () => ({ toast: { error: fns.toastError } }));

import PythonFunctionPanel, { type PythonFunctionSave } from '../PythonFunctionPanel';

const appTheme = extendTheme({ ...getThemeConfig() });

const CODE = 'FUNCTION = {...}\n\ndef run(load, span, elastic_modulus, second_moment):\n    return {}';

const sampleContract = () => ({
  name: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam under a uniform load.',
  inputs: {
    type: 'object',
    additionalProperties: false,
    required: ['load', 'span', 'elastic_modulus', 'second_moment'],
    properties: {
      load: { type: 'number', unit: 'N/m', exclusiveMinimum: 0 },
      span: { type: 'number', unit: 'm', exclusiveMinimum: 0 } as Record<string, unknown>,
      elastic_modulus: { type: 'number', unit: 'Pa', exclusiveMinimum: 0 },
      second_moment: { type: 'number', unit: 'm^4', exclusiveMinimum: 0 },
    },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['deflection'],
    properties: { deflection: { type: 'number', unit: 'm' } },
  },
});

const described = (contract: unknown = sampleContract()) => ({
  success: true,
  contract,
  output: '',
  executionTime: 4,
});

const renderPanel = (disabled = false, save: PythonFunctionSave | null = null) => {
  const view = render(
    <CssVarsProvider theme={appTheme}>
      <PythonFunctionPanel code={CODE} packages={[]} disabled={disabled} save={save} />
    </CssVarsProvider>
  );
  const rerender = (nextDisabled: boolean) =>
    view.rerender(
      <CssVarsProvider theme={appTheme}>
        <PythonFunctionPanel code={CODE} packages={[]} disabled={nextDisabled} save={save} />
      </CssVarsProvider>
    );
  return { rerender };
};

const fillSampleInputs = () => {
  const values = { load: '1000', span: '4', elastic_modulus: '200000000000', second_moment: '0.000008' };
  for (const [name, value] of Object.entries(values)) {
    fireEvent.change(screen.getByTestId(`python-function-input-${name}`), { target: { value } });
  }
};

describe('PythonFunctionPanel', () => {
  beforeEach(() => {
    callFunction.mockReset();
  });

  it('shows the status line, then the contract tables and a form with units', async () => {
    callFunction.mockResolvedValueOnce(described());
    renderPanel();

    expect(screen.getByTestId('python-function-status').textContent).toBe('Reading the function contract');
    const inputs = await screen.findByTestId('python-function-contract-inputs', {}, { timeout: 2000 });
    expect(callFunction).toHaveBeenCalledWith(CODE, null, []);

    expect(within(inputs).getByText('N/m')).toBeTruthy();
    expect(within(inputs).getByText('m^4')).toBeTruthy();
    expect(within(inputs).getAllByText('greater than 0')).toHaveLength(4);
    const outputs = screen.getByTestId('python-function-contract-outputs');
    expect(within(outputs).getByText('deflection')).toBeTruthy();
    expect(screen.getByText('beam_midspan_deflection')).toBeTruthy();
    expect(screen.queryByText(/test case/)).toBeNull();
    // Each numeric input carries its unit beside it.
    const spanControl = screen.getByTestId('python-function-input-span').parentElement as HTMLElement;
    expect(within(spanControl).getByText('m')).toBeTruthy();
    expect(screen.getByText('Calls run in your browser. Call results are not saved.')).toBeTruthy();
  });

  it('lists contract problems and offers no call button', async () => {
    const contract = sampleContract();
    delete contract.inputs.properties.span.unit;
    callFunction.mockResolvedValueOnce(described(contract));
    renderPanel();

    const problems = await screen.findByTestId('python-function-problems', {}, { timeout: 2000 });
    expect(problems.textContent).toContain('The function contract has problems:');
    expect(problems.textContent).toContain('inputs.properties.span.unit');
    expect(screen.queryByTestId('python-function-call-btn')).toBeNull();
  });

  it('explains a missing FUNCTION contract', async () => {
    callFunction.mockResolvedValueOnce({
      success: false,
      error: 'FUNCTION is not defined',
      output: '',
      executionTime: 1,
    });
    renderPanel();

    expect(
      await screen.findByText(
        'This artifact needs a FUNCTION contract and a run function to be called.',
        {},
        { timeout: 2000 }
      )
    ).toBeTruthy();
  });

  it('names an input that does not match the contract and does not call run', async () => {
    callFunction.mockResolvedValueOnce(described());
    renderPanel();
    await screen.findByTestId('python-function-call-btn', {}, { timeout: 2000 });

    fillSampleInputs();
    fireEvent.change(screen.getByTestId('python-function-input-span'), { target: { value: '-1' } });
    fireEvent.click(screen.getByTestId('python-function-call-btn'));

    const problems = await screen.findByTestId('python-function-problems');
    expect(problems.textContent).toContain('These inputs do not match the contract:');
    expect(problems.textContent).toContain('span: must be greater than 0');
    expect(callFunction).toHaveBeenCalledTimes(1);
  });

  it('calls run with the typed inputs and shows the result with units', async () => {
    callFunction.mockResolvedValueOnce(described()).mockResolvedValueOnce({
      success: true,
      contract: sampleContract(),
      value: { deflection: 0.0020833333333333333 },
      output: 'computing\n',
      executionTime: 12.4,
    });
    renderPanel();
    await screen.findByTestId('python-function-call-btn', {}, { timeout: 2000 });

    fillSampleInputs();
    fireEvent.click(screen.getByTestId('python-function-call-btn'));

    const result = await screen.findByTestId('python-function-result');
    expect(callFunction).toHaveBeenLastCalledWith(
      CODE,
      { load: 1000, span: 4, elastic_modulus: 200000000000, second_moment: 0.000008 },
      []
    );
    const row = within(result).getByText('deflection').closest('tr') as HTMLElement;
    expect(within(row).getByText('0.0020833333333333333')).toBeTruthy();
    expect(within(row).getByText('m')).toBeTruthy();
    expect(screen.getByText('Ran in 12 ms.')).toBeTruthy();
    expect(screen.getByTestId('python-function-printed-output').textContent).toContain('computing');

    for (const id of [
      'python-function-contract-inputs',
      'python-function-contract-outputs',
      'python-function-result',
    ]) {
      const table = screen.getByTestId(id);
      expect(getComputedStyle(table).tableLayout).toBe('auto');
      expect(getComputedStyle(table.parentElement as HTMLElement).overflowX).toBe('auto');
    }
  });

  it('lists output problems when run returns values that do not match the contract', async () => {
    callFunction.mockResolvedValueOnce(described()).mockResolvedValueOnce({
      success: true,
      value: { deflection: 'big' },
      output: '',
      executionTime: 3,
    });
    renderPanel();
    await screen.findByTestId('python-function-call-btn', {}, { timeout: 2000 });

    fillSampleInputs();
    fireEvent.click(screen.getByTestId('python-function-call-btn'));

    const problems = await screen.findByTestId('python-function-problems');
    expect(problems.textContent).toContain('The function returned values that do not match the contract:');
    expect(problems.textContent).toContain('deflection: must be a number');
    expect(screen.queryByTestId('python-function-result')).toBeNull();
  });

  it('lists an output problem the sandbox found before JSON hid the Python type', async () => {
    const contract = sampleContract();
    contract.outputs.properties = { count: { type: 'integer', unit: '1' } } as never;
    contract.outputs.required = ['count'];
    callFunction.mockResolvedValueOnce(described(contract)).mockResolvedValueOnce({
      success: true,
      value: { count: 3 },
      outputProblems: [{ path: 'count', message: 'must be a whole number' }],
      output: '',
      executionTime: 3,
    });
    renderPanel();
    await screen.findByTestId('python-function-call-btn', {}, { timeout: 2000 });

    fillSampleInputs();
    fireEvent.click(screen.getByTestId('python-function-call-btn'));

    const problems = await screen.findByTestId('python-function-problems');
    expect(problems.textContent).toContain('The function returned values that do not match the contract:');
    expect(problems.textContent).toContain('count: must be a whole number');
    expect(screen.queryByTestId('python-function-result')).toBeNull();
  });

  it('passes 3.0 typed into a whole-number input to run as 3', async () => {
    const contract = sampleContract();
    contract.inputs.properties.span = { type: 'integer', unit: 'm', exclusiveMinimum: 0 };
    callFunction.mockResolvedValueOnce(described(contract)).mockResolvedValueOnce({
      success: true,
      value: { deflection: 1 },
      output: '',
      executionTime: 1,
    });
    renderPanel();
    await screen.findByTestId('python-function-call-btn', {}, { timeout: 2000 });

    fillSampleInputs();
    fireEvent.change(screen.getByTestId('python-function-input-span'), { target: { value: '3.0' } });
    fireEvent.click(screen.getByTestId('python-function-call-btn'));

    await screen.findByTestId('python-function-result');
    expect(callFunction).toHaveBeenLastCalledWith(
      CODE,
      { load: 1000, span: 3, elastic_modulus: 200000000000, second_moment: 0.000008 },
      []
    );
  });

  it('shows the error when run raises', async () => {
    const traceback = 'Traceback (most recent call last):\nZeroDivisionError: division by zero';
    callFunction.mockResolvedValueOnce(described()).mockResolvedValueOnce({
      success: false,
      error: traceback,
      output: '',
      executionTime: 2,
    });
    renderPanel();
    await screen.findByTestId('python-function-call-btn', {}, { timeout: 2000 });

    fillSampleInputs();
    fireEvent.click(screen.getByTestId('python-function-call-btn'));

    const error = await screen.findByTestId('python-function-error');
    expect(error.textContent).toContain('The function raised an error:');
    expect(error.textContent).toContain('ZeroDivisionError: division by zero');
  });

  it('renders at most 50 problems and a closing line for a flooded contract', async () => {
    const contract = sampleContract() as Record<string, unknown>;
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) properties[`p${i}`] = { type: 'number', x: 1 };
    contract.inputs = { type: 'object', additionalProperties: false, properties };
    callFunction.mockResolvedValueOnce(described(contract));
    renderPanel();

    const problems = await screen.findByTestId('python-function-problems', {}, { timeout: 2000 });
    const rows = problems.querySelectorAll('li');
    expect(rows.length).toBeLessThanOrEqual(51);
    expect(rows[rows.length - 1].textContent).toBe('more problems were found; the first 50 are listed');
  });

  it('prefills defaults for fields named after inherited object keys and passes them to run', async () => {
    const contract = JSON.parse(
      JSON.stringify({
        ...sampleContract(),
        inputs: {
          type: 'object',
          additionalProperties: false,
          required: ['constructor'],
          properties: {
            constructor: { type: 'number', unit: 'm', default: 6 },
            toString: { type: 'boolean', default: true },
            proto: { type: 'number', unit: 'm', default: 5 },
          },
        },
      }).replace('"proto"', '"__proto__"')
    );
    callFunction.mockResolvedValueOnce(described(contract)).mockResolvedValueOnce({
      success: true,
      value: { deflection: 1 },
      output: '',
      executionTime: 1,
    });
    renderPanel();

    const field = (await screen.findByTestId(
      'python-function-input-constructor',
      {},
      { timeout: 2000 }
    )) as HTMLInputElement;
    expect(field.value).toBe('6');
    expect((screen.getByTestId('python-function-input-toString') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('python-function-input-__proto__') as HTMLInputElement).value).toBe('5');

    fireEvent.click(screen.getByTestId('python-function-call-btn'));
    await screen.findByTestId('python-function-result');
    const params = callFunction.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(Object.getOwnPropertyDescriptor(params, 'constructor')?.value).toBe(6);
    expect(Object.getOwnPropertyDescriptor(params, 'toString')?.value).toBe(true);
    expect(Object.getOwnPropertyDescriptor(params, '__proto__')?.value).toBe(5);
  });

  it('keeps reading, with no error shown, when a run holds the sandbox during the read', async () => {
    callFunction.mockRejectedValueOnce(new Error(PYTHON_SCRIPT_BUSY)).mockResolvedValueOnce(described());
    const { rerender } = renderPanel();

    await waitFor(() => expect(callFunction).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await act(async () => {});
    expect(screen.getByTestId('python-function-status').textContent).toBe('Reading the function contract');
    expect(screen.queryByTestId('python-function-error')).toBeNull();

    rerender(true);
    rerender(false);
    await screen.findByTestId('python-function-contract-inputs', {}, { timeout: 2000 });
    expect(callFunction).toHaveBeenCalledTimes(2);
  });

  it('checks returned values against the contract it displayed, not one the call returns', async () => {
    const loose = sampleContract();
    (loose.outputs.properties as Record<string, unknown>).deflection = { type: 'string' };
    callFunction.mockResolvedValueOnce(described()).mockResolvedValueOnce({
      success: true,
      contract: loose,
      value: { deflection: 'big' },
      output: '',
      executionTime: 3,
    });
    renderPanel();
    await screen.findByTestId('python-function-call-btn', {}, { timeout: 2000 });

    fillSampleInputs();
    fireEvent.click(screen.getByTestId('python-function-call-btn'));

    const problems = await screen.findByTestId('python-function-problems');
    expect(problems.textContent).toContain('deflection: must be a number');
    expect(screen.queryByTestId('python-function-result')).toBeNull();
  });

  it('disables every control while disabled', async () => {
    callFunction.mockResolvedValueOnce(described());
    const { rerender } = renderPanel();
    await screen.findByTestId('python-function-call-btn', {}, { timeout: 2000 });

    rerender(true);

    expect((screen.getByTestId('python-function-call-btn') as HTMLButtonElement).disabled).toBe(true);
    for (const name of ['load', 'span', 'elastic_modulus', 'second_moment']) {
      expect((screen.getByTestId(`python-function-input-${name}`) as HTMLInputElement).disabled).toBe(true);
    }
    expect(callFunction).toHaveBeenCalledTimes(1);
  });
});

describe('PythonFunctionPanel save controls', () => {
  const TARGET: PythonFunctionSave = { artifactId: 'artifact-1', version: 3, blocked: null };
  const HASH = 'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

  const savedView = (overrides: Record<string, unknown> = {}) => ({
    id: 'fn-1',
    slug: 'beam_midspan_deflection',
    description: 'Midspan deflection of a simply supported beam under a uniform load.',
    status: 'draft',
    state: 'draft',
    enabled: true,
    pin: { artifactId: 'artifact-1', version: 3, contentHash: HASH, pinnedAt: '2026-11-22T10:00:00.000Z' },
    latestVersion: 3,
    updateAvailable: false,
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:00.000Z',
    ...overrides,
  });

  const newerVersion = () => savedView({ latestVersion: 4, updateAvailable: true });

  const axiosError = (status: number, error: string) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      isAxiosError: true,
      response: { status, data: { error, request_id: 'req-1' } },
    });

  const renderReady = async (save: PythonFunctionSave | null) => {
    callFunction.mockResolvedValueOnce(described());
    const { rerender } = renderPanel(false, save);
    await screen.findByTestId('python-function-contract-inputs', {}, { timeout: 2000 });
    return { rerender: () => rerender(false) };
  };

  const follows = (later: HTMLElement, earlier: HTMLElement) =>
    Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

  const statusText = () => screen.getByTestId('python-function-saved-status').textContent;

  beforeEach(() => {
    callFunction.mockReset();
    fns.saved = { data: null, isLoading: false };
    fns.query.mockReset();
    fns.repin = { mutate: vi.fn(), isPending: false };
    fns.setEnabled = { mutate: vi.fn(), isPending: false };
    fns.remove = { mutate: vi.fn(), isPending: false };
    fns.dialog.mockReset();
    fns.toastError.mockReset();
  });

  it('offers no save controls when save is null', async () => {
    await renderReady(null);

    expect(screen.queryByTestId('python-function-save-btn')).toBeNull();
    expect(screen.queryByTestId('python-function-save-blocked')).toBeNull();
    expect(screen.queryByTestId('python-function-saved-status')).toBeNull();
    expect(fns.query).not.toHaveBeenCalled();
  });

  it('shows no save controls while the saved tool loads', async () => {
    fns.saved = { data: undefined, isLoading: true };
    await renderReady(TARGET);

    expect(fns.query).toHaveBeenCalledWith('artifact-1', 3);
    expect(screen.queryByTestId('python-function-save-btn')).toBeNull();
    expect(screen.queryByTestId('python-function-saved-status')).toBeNull();
  });

  it('puts the save controls under the name, above the inputs, and a call result under Call function', async () => {
    await renderReady(TARGET);
    callFunction.mockResolvedValueOnce({
      success: true,
      value: { deflection: 0.002 },
      output: '',
      executionTime: 3,
    });

    const save = screen.getByTestId('python-function-save-btn');
    expect(follows(screen.getByTestId('python-function-contract-inputs'), save)).toBe(true);
    fillSampleInputs();
    fireEvent.click(screen.getByTestId('python-function-call-btn'));

    const result = await screen.findByTestId('python-function-result');
    expect(follows(result, screen.getByTestId('python-function-call-btn'))).toBe(true);
    expect(follows(result, save)).toBe(true);
  });

  it('Make this a tool opens the save dialog with the artifact, the version shown, and the contract read', async () => {
    await renderReady(TARGET);

    const button = screen.getByTestId('python-function-save-btn');
    expect(button.textContent).toBe('Make this a tool');
    expect(screen.queryByTestId('save-function-dialog')).toBeNull();

    fireEvent.click(button);

    expect(screen.getByTestId('save-function-dialog')).toBeTruthy();
    expect(fns.dialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true, artifactId: 'artifact-1', version: 3, contract: sampleContract() })
    );
  });

  it.each([
    'Save the artifact to make it a tool.',
    'Save your changes to make this a tool.',
    'Switch to the latest version to make this a tool.',
  ])('shows the blocked note "%s" in place of the button', async blocked => {
    await renderReady({ artifactId: 'artifact-1', version: 3, blocked });

    expect(screen.getByTestId('python-function-save-blocked').textContent).toBe(blocked);
    expect(screen.queryByTestId('python-function-save-btn')).toBeNull();
  });

  it('saved as a draft: names the pinned version and offers Turn off and Delete, not Update', async () => {
    fns.saved = { data: savedView(), isLoading: false };
    await renderReady(TARGET);

    expect(statusText()).toBe('Saved as a draft tool, pinned to version 3.');
    expect(screen.queryByTestId('python-function-save-btn')).toBeNull();
    expect(screen.queryByTestId('python-function-repin-btn')).toBeNull();
    expect(screen.getByTestId('python-function-enable-btn').textContent).toBe('Turn off');
    expect(screen.getByTestId('python-function-delete-btn').textContent).toBe('Delete');
  });

  it('a newer version is available: says so and Update repins to the version shown with the contract read', async () => {
    fns.saved = { data: newerVersion(), isLoading: false };
    await renderReady({ artifactId: 'artifact-1', version: 4, blocked: null });

    expect(statusText()).toBe(
      'A newer version is available. This tool is pinned to version 3, and the artifact is at version 4.'
    );
    const update = screen.getByTestId('python-function-repin-btn');
    expect(update.textContent).toBe('Update to version 4');

    fireEvent.click(update);

    expect(fns.repin.mutate).toHaveBeenCalledWith(
      { id: 'fn-1', expectedVersion: 4, contract: sampleContract() },
      expect.objectContaining({ onError: expect.any(Function) })
    );
  });

  it('a newer version is available but the viewer is blocked: keeps the status and hides Update', async () => {
    fns.saved = { data: newerVersion(), isLoading: false };
    await renderReady({ artifactId: 'artifact-1', version: 4, blocked: 'Save your changes to make this a tool.' });

    expect(statusText()).toContain('A newer version is available.');
    expect(screen.queryByTestId('python-function-repin-btn')).toBeNull();
    expect(screen.queryByTestId('python-function-save-blocked')).toBeNull();
  });

  it('turned off: says so above the pinned version, and Turn on turns it back on', async () => {
    fns.saved = { data: savedView({ enabled: false, status: 'disabled' }), isLoading: false };
    await renderReady(TARGET);

    expect(statusText()).toBe('This tool is turned off.Saved as a draft tool, pinned to version 3.');
    const toggle = screen.getByTestId('python-function-enable-btn');
    expect(toggle.textContent).toBe('Turn on');

    fireEvent.click(toggle);

    expect(fns.setEnabled.mutate).toHaveBeenCalledWith({ id: 'fn-1', enabled: true }, expect.anything());
  });

  it('Turn off turns the tool off', async () => {
    fns.saved = { data: savedView(), isLoading: false };
    await renderReady(TARGET);

    fireEvent.click(screen.getByTestId('python-function-enable-btn'));

    expect(fns.setEnabled.mutate).toHaveBeenCalledWith({ id: 'fn-1', enabled: false }, expect.anything());
  });

  it.each([
    ['on', true],
    ['off', false],
  ])('the artifact was deleted, tool turned %s: says so and offers only Delete', async (_label, enabled) => {
    fns.saved = {
      data: savedView({ status: 'source_deleted', enabled, latestVersion: 4, updateAvailable: false }),
      isLoading: false,
    };
    await renderReady(TARGET);

    expect(statusText()).toBe('The artifact this tool was saved from was deleted.');
    expect(screen.queryByTestId('python-function-repin-btn')).toBeNull();
    expect(screen.queryByTestId('python-function-enable-btn')).toBeNull();
    expect(screen.getByTestId('python-function-delete-btn').textContent).toBe('Delete');
  });

  it('once a save lands and its dialog closes, focuses the first button of the saved state', async () => {
    const { rerender } = await renderReady(TARGET);
    fireEvent.click(screen.getByTestId('python-function-save-btn'));
    const { onClose } = fns.dialog.mock.lastCall![0] as { onClose: (saved: boolean) => void };

    fns.saved = { data: savedView(), isLoading: false };
    act(() => onClose(true));
    rerender();

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('python-function-enable-btn')));
  });

  it('once a delete lands, focuses Make this a tool', async () => {
    fns.saved = { data: savedView(), isLoading: false };
    const { rerender } = await renderReady(TARGET);
    fireEvent.click(screen.getByTestId('python-function-delete-btn'));
    fireEvent.click(screen.getByTestId('python-function-delete-confirm-btn'));
    const [, callbacks] = fns.remove.mutate.mock.calls[0] as [
      unknown,
      { onSuccess: () => void; onSettled: () => void },
    ];

    act(() => {
      callbacks.onSuccess();
      callbacks.onSettled();
    });
    fns.saved = { data: null, isLoading: false };
    rerender();

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('python-function-save-btn')));
  });

  it('once an update lands, focuses Turn off, which takes the place of Update', async () => {
    fns.saved = { data: newerVersion(), isLoading: false };
    const { rerender } = await renderReady({ artifactId: 'artifact-1', version: 4, blocked: null });
    fireEvent.click(screen.getByTestId('python-function-repin-btn'));
    const [, callbacks] = fns.repin.mutate.mock.calls[0] as [unknown, { onSuccess: () => void }];

    act(() => callbacks.onSuccess());
    fns.saved = { data: savedView({ pin: { ...savedView().pin, version: 4 }, latestVersion: 4 }), isLoading: false };
    rerender();

    expect(screen.queryByTestId('python-function-repin-btn')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('python-function-enable-btn')));
  });

  it('Delete asks first, names the tool, and deletes it on confirm', async () => {
    fns.saved = { data: savedView(), isLoading: false };
    await renderReady(TARGET);

    fireEvent.click(screen.getByTestId('python-function-delete-btn'));

    const dialog = screen.getByTestId('python-function-delete-dialog');
    expect(within(dialog).getByText('Delete this tool?')).toBeTruthy();
    expect(dialog.textContent).toContain('This deletes the tool beam_midspan_deflection. The artifact is not changed.');
    expect(fns.remove.mutate).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByTestId('python-function-delete-confirm-btn'));

    expect(fns.remove.mutate).toHaveBeenCalledWith(
      'fn-1',
      expect.objectContaining({ onError: expect.any(Function), onSettled: expect.any(Function) })
    );
  });

  it('Cancel in the delete dialog deletes nothing', async () => {
    fns.saved = { data: savedView(), isLoading: false };
    await renderReady(TARGET);

    fireEvent.click(screen.getByTestId('python-function-delete-btn'));
    fireEvent.click(screen.getByTestId('python-function-delete-cancel-btn'));

    await waitFor(() => expect(screen.queryByTestId('python-function-delete-dialog')).toBeNull());
    expect(fns.remove.mutate).not.toHaveBeenCalled();
  });

  it.each([
    ['Update', 'python-function-repin-btn', 'repin', newerVersion(), 'Could not update the tool.'],
    ['Turn off', 'python-function-enable-btn', 'setEnabled', savedView(), 'Could not turn off the tool.'],
    [
      'Turn on',
      'python-function-enable-btn',
      'setEnabled',
      savedView({ enabled: false, status: 'disabled' }),
      'Could not turn on the tool.',
    ],
  ] as const)('a failed %s shows a toast with the reason', async (_label, testId, mutation, view, title) => {
    fns.saved = { data: view, isLoading: false };
    await renderReady({ artifactId: 'artifact-1', version: 4, blocked: null });

    fireEvent.click(screen.getByTestId(testId));
    const [, { onError }] = fns[mutation].mutate.mock.calls[0] as [unknown, { onError: (error: unknown) => void }];
    act(() => onError(axiosError(409, 'The artifact changed since you opened it. Reload it and try again.')));

    expect(fns.toastError).toHaveBeenCalledWith(title, {
      description: 'The artifact changed since you opened it. Reload it and try again.',
    });
  });

  it('a failed Delete shows a toast and closes the dialog', async () => {
    fns.saved = { data: savedView(), isLoading: false };
    await renderReady(TARGET);

    fireEvent.click(screen.getByTestId('python-function-delete-btn'));
    fireEvent.click(screen.getByTestId('python-function-delete-confirm-btn'));
    const [, callbacks] = fns.remove.mutate.mock.calls[0] as [
      unknown,
      { onError: (error: unknown) => void; onSettled: () => void },
    ];
    act(() => {
      callbacks.onError(new Error('Network Error'));
      callbacks.onSettled();
    });

    expect(fns.toastError).toHaveBeenCalledWith('Could not delete the tool.', undefined);
    await waitFor(() => expect(screen.queryByTestId('python-function-delete-dialog')).toBeNull());
  });
});
