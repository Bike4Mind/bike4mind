import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within, waitFor, act, cleanup } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { PYTHON_SCRIPT_BUSY } from '@client/app/utils/pyodideManager';

const callFunction = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/usePyodide', () => ({ usePyodide: () => ({ callFunction }) }));

const fns = vi.hoisted(() => ({
  saved: { data: null as unknown, isLoading: false },
  others: [] as unknown[],
  query: vi.fn(),
  repin: { mutate: vi.fn(), isPending: false },
  setEnabled: { mutate: vi.fn(), isPending: false },
  setApproval: { mutate: vi.fn(), isPending: false },
  remove: { mutate: vi.fn(), isPending: false },
  dialog: vi.fn(),
  toastError: vi.fn(),
  dataFiles: vi.fn(),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
vi.mock('@client/app/hooks/data/callableFunctions', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/callableFunctions')>()),
  useArtifactCallableFunction: (artifactId: string | null, version: number, name: string) => {
    fns.query(artifactId, version, name);
    const { data, isLoading } = fns.saved;
    return { isLoading, data: data === undefined ? undefined : { saved: data, others: fns.others } };
  },
  useRepinCallableFunction: () => fns.repin,
  useSetCallableFunctionEnabled: () => fns.setEnabled,
  useSetCallableFunctionApproval: () => fns.setApproval,
  useDeleteCallableFunction: () => fns.remove,
  fetchCallableFunctionDataFiles: (...args: unknown[]) => fns.dataFiles(...args),
}));
vi.mock('../SaveFunctionDialog', () => ({
  default: (props: Record<string, unknown>) => {
    fns.dialog(props);
    return <div data-testid="save-function-dialog" />;
  },
}));
vi.mock('sonner', () => ({ toast: { error: fns.toastError } }));
vi.mock('../FunctionDataSection', () => ({ default: () => null }));
vi.mock('../FunctionSourcesSection', () => ({ default: () => null }));
// Its own behavior is in PromoteFunctionSection.test.tsx; here only where it mounts and why it is blocked.
vi.mock('../PromoteFunctionSection', () => ({
  default: ({ blocked }: { blocked: string | null }) => (
    <div data-testid="promote-section-stub">{blocked ?? 'ready'}</div>
  ),
}));

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
  const rerender = (nextDisabled: boolean, nextCode = CODE) =>
    view.rerender(
      <CssVarsProvider theme={appTheme}>
        <PythonFunctionPanel code={nextCode} packages={[]} disabled={nextDisabled} save={save} />
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
      [],
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
      [],
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

  it('reads hex or other non-decimal text in a number field as text, so the contract check names the field', async () => {
    callFunction.mockResolvedValueOnce(described());
    renderPanel();
    await screen.findByTestId('python-function-call-btn', {}, { timeout: 2000 });

    fillSampleInputs();
    for (const text of ['0x10', '0b1', 'Infinity']) {
      fireEvent.change(screen.getByTestId('python-function-input-span'), { target: { value: text } });
      fireEvent.click(screen.getByTestId('python-function-call-btn'));
      expect((await screen.findByTestId('python-function-problems')).textContent).toContain('span: must be a number');
    }
    expect(callFunction).toHaveBeenCalledTimes(1);
  });

  it('holds Call function after an edit until the new code is read, then calls with that code', async () => {
    callFunction.mockResolvedValueOnce(described());
    const { rerender } = renderPanel();
    await screen.findByTestId('python-function-call-btn', {}, { timeout: 2000 });
    fillSampleInputs();

    const edited = `${CODE}\n# edited`;
    callFunction.mockResolvedValueOnce(described());
    rerender(false, edited);
    const button = screen.getByTestId('python-function-call-btn') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(callFunction).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(callFunction).toHaveBeenLastCalledWith(edited, null, []), { timeout: 2000 });
    callFunction.mockResolvedValueOnce({ success: true, value: { deflection: 1 }, output: '', executionTime: 1 });
    await waitFor(() =>
      expect((screen.getByTestId('python-function-call-btn') as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(screen.getByTestId('python-function-call-btn'));
    await screen.findByTestId('python-function-result');
    expect(callFunction).toHaveBeenLastCalledWith(edited, expect.objectContaining({ span: 4 }), [], []);
  });
});

describe('PythonFunctionPanel tests', () => {
  const STEEL_INPUT = { load: 1000, span: 4, elastic_modulus: 2e11, second_moment: 8e-6 };
  const testedContract = () => ({
    ...sampleContract(),
    tests: [
      { name: '4 m steel beam', input: STEEL_INPUT, expected: { deflection: 0.0020833 }, tolerance: { rel: 0.001 } },
      {
        name: '2 m steel beam',
        input: { ...STEEL_INPUT, span: 2 },
        expected: { deflection: 0.00013021 },
        tolerance: { rel: 0.001 },
      },
    ],
  });
  const returned = (deflection: unknown) => ({ success: true, value: { deflection }, output: '', executionTime: 2 });

  beforeEach(() => {
    callFunction.mockReset();
  });

  const openTests = async () => {
    renderPanel();
    return screen.findByTestId('python-function-tests', {}, { timeout: 2000 });
  };
  const statuses = () => screen.getAllByTestId('python-function-test-status').map(cell => cell.textContent);

  it('runs each case through run in turn and shows each pass', async () => {
    callFunction
      .mockResolvedValueOnce(described(testedContract()))
      .mockResolvedValueOnce(returned(0.00208333))
      .mockResolvedValueOnce(returned(0.000130208));
    const section = await openTests();
    expect(statuses()).toEqual(['-', '-']);

    fireEvent.click(within(section).getByTestId('python-function-tests-run-btn'));

    await waitFor(() => expect(statuses()).toEqual(['Passed', 'Passed']));
    expect(callFunction).toHaveBeenNthCalledWith(2, CODE, STEEL_INPUT, [], []);
    expect(callFunction).toHaveBeenNthCalledWith(3, CODE, { ...STEEL_INPUT, span: 2 }, [], []);
    expect(screen.getAllByTestId('python-function-test-row').map(row => row.textContent)).toEqual([
      '4 m steel beamPassed (2 ms)',
      '2 m steel beamPassed (2 ms)',
    ]);
    expect(screen.queryByTestId('python-function-test-failure')).toBeNull();
  });

  it('names the failing field and both values, and stops at the first failure', async () => {
    callFunction.mockResolvedValueOnce(described(testedContract())).mockResolvedValueOnce(returned(0.0031));
    const section = await openTests();

    fireEvent.click(within(section).getByTestId('python-function-tests-run-btn'));

    const failure = await screen.findByTestId('python-function-test-failure');
    expect(failure.textContent).toBe(
      '4 m steel beam: output deflection expected 0.0020833, got 0.0031 (tolerance 0.001 relative).'
    );
    expect(statuses()).toEqual(['Failed', 'Not run']);
    expect(callFunction).toHaveBeenCalledTimes(2);
  });

  it('quotes text values in the failure line and lets a long one wrap', async () => {
    const labeled = {
      ...sampleContract(),
      outputs: {
        type: 'object',
        additionalProperties: false,
        required: ['label'],
        properties: { label: { type: 'string' } },
      },
      tests: [{ name: 'blank label', input: STEEL_INPUT, expected: { label: '' } }],
    };
    callFunction
      .mockResolvedValueOnce(described(labeled))
      .mockResolvedValueOnce({ success: true, value: { label: ' ' }, output: '', executionTime: 1 });
    const section = await openTests();
    fireEvent.click(within(section).getByTestId('python-function-tests-run-btn'));

    const failure = await screen.findByTestId('python-function-test-failure');
    expect(failure.textContent).toBe('blank label: output label expected "", got " ".');
    expect(getComputedStyle(within(failure).getByText(/blank label/)).wordBreak).toBe('break-word');
  });

  it('announces the results politely to screen readers', async () => {
    callFunction.mockResolvedValueOnce(described(testedContract()));
    const section = await openTests();
    expect(within(section).getByTestId('python-function-test-results').getAttribute('aria-live')).toBe('polite');
  });

  it('says when run left an expected output out', async () => {
    callFunction
      .mockResolvedValueOnce(described(testedContract()))
      .mockResolvedValueOnce({ success: true, value: {}, output: '', executionTime: 1 });
    const section = await openTests();
    fireEvent.click(within(section).getByTestId('python-function-tests-run-btn'));

    const problems = await screen.findByTestId('python-function-problems');
    expect(problems.textContent).toContain('deflection: is required');
    expect(statuses()).toEqual(['Failed', 'Not run']);
  });

  it('shows the error of a case that raised or passed the time limit, then lets the tests run again', async () => {
    callFunction.mockResolvedValueOnce(described(testedContract())).mockResolvedValueOnce({
      success: false,
      error: 'Stopped at the time limit of 30 s.',
      output: '',
      executionTime: 0,
    });
    const section = await openTests();
    fireEvent.click(within(section).getByTestId('python-function-tests-run-btn'));

    expect((await screen.findByTestId('python-function-error')).textContent).toContain(
      '4 m steel beam: Stopped at the time limit of 30 s.'
    );
    expect(statuses()).toEqual(['Failed', 'Not run']);
    const runButton = within(section).getByTestId('python-function-tests-run-btn') as HTMLButtonElement;
    await waitFor(() => expect(runButton.disabled).toBe(false));

    callFunction.mockResolvedValueOnce(returned(0.0020833)).mockResolvedValueOnce(returned(0.00013021));
    fireEvent.click(runButton);
    await waitFor(() => expect(statuses()).toEqual(['Passed', 'Passed']));
  });

  it('offers no Tests section when the contract declares none', async () => {
    callFunction.mockResolvedValueOnce(described());
    renderPanel();
    await screen.findByTestId('python-function-call-btn', {}, { timeout: 2000 });
    expect(screen.queryByTestId('python-function-tests')).toBeNull();
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
    return {
      rerender: () => rerender(false),
      rerenderCode: (code: string, disabled = false) => rerender(disabled, code),
    };
  };

  const follows = (later: HTMLElement, earlier: HTMLElement) =>
    Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

  const statusText = () => screen.getByTestId('python-function-saved-status').textContent;

  beforeEach(() => {
    callFunction.mockReset();
    fns.saved = { data: null, isLoading: false };
    fns.others = [];
    fns.query.mockReset();
    fns.dataFiles.mockReset();
    fns.repin = { mutate: vi.fn(), isPending: false };
    fns.setEnabled = { mutate: vi.fn(), isPending: false };
    fns.setApproval = { mutate: vi.fn(), isPending: false };
    fns.remove = { mutate: vi.fn(), isPending: false };
    fns.dialog.mockReset();
    fns.toastError.mockReset();
  });

  it('offers no save controls when save is null', async () => {
    await renderReady(null);

    expect(screen.queryByTestId('python-function-save-btn')).toBeNull();
    expect(screen.queryByTestId('python-function-save-blocked')).toBeNull();
    expect(screen.queryByTestId('python-function-saved-status')).toBeNull();
    // The hook is disabled for a null artifact, so no lookup is made.
    expect(fns.query.mock.calls.every(([artifactId]) => artifactId === null)).toBe(true);
  });

  it('shows no save controls while the saved tool loads', async () => {
    fns.saved = { data: undefined, isLoading: true };
    await renderReady(TARGET);

    expect(fns.query).toHaveBeenCalledWith('artifact-1', 3, 'beam_midspan_deflection');
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

  it.each([false, true])(
    'hides the save controls once the code changes, until the new code is read (disabled: %s)',
    async disabled => {
      const { rerenderCode } = await renderReady(TARGET);
      expect(screen.getByTestId('python-function-save-btn')).toBeTruthy();

      callFunction.mockResolvedValueOnce(described());
      rerenderCode(`${CODE}\n# edited`, disabled);

      expect(screen.queryByTestId('python-function-save-btn')).toBeNull();
      if (!disabled) {
        await waitFor(() => expect(screen.getByTestId('python-function-save-btn')).toBeTruthy(), { timeout: 2000 });
      }
    }
  );

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

  it("hands a pinned tool's verified data files to the call", async () => {
    const pin = { name: 'points.csv', sha256: 'a'.repeat(64), bytes: 3, pinnedAt: '2026-11-22T10:00:00.000Z' };
    const files = [{ name: 'points.csv', bytes: new Uint8Array([1, 2, 3]).buffer }];
    fns.saved = { data: savedView({ dataPins: [pin] }), isLoading: false };
    fns.dataFiles.mockResolvedValueOnce(files);
    await renderReady(TARGET);
    callFunction.mockResolvedValueOnce({ success: true, value: { deflection: 1 }, output: '', executionTime: 1 });

    fillSampleInputs();
    fireEvent.click(screen.getByTestId('python-function-call-btn'));

    await screen.findByTestId('python-function-result');
    expect(fns.dataFiles).toHaveBeenCalledWith('fn-1', [pin]);
    expect(callFunction).toHaveBeenLastCalledWith(CODE, expect.objectContaining({ span: 4 }), [], files);
  });

  it("shows a pinned file's read failure and does not call run", async () => {
    const pin = { name: 'points.csv', sha256: 'a'.repeat(64), bytes: 3, pinnedAt: '2026-11-22T10:00:00.000Z' };
    fns.saved = { data: savedView({ dataPins: [pin] }), isLoading: false };
    fns.dataFiles.mockRejectedValueOnce(new Error('The data file points.csv does not match its pinned hash.'));
    await renderReady(TARGET);

    fillSampleInputs();
    fireEvent.click(screen.getByTestId('python-function-call-btn'));

    const error = await screen.findByTestId('python-function-error');
    expect(error.textContent).toContain('The data file points.csv does not match its pinned hash.');
    expect(callFunction).toHaveBeenCalledTimes(1);
  });

  it('mounts promotion under a saved tool, blocked while the tool is off or pinned to another version', async () => {
    fns.saved = { data: savedView(), isLoading: false };
    await renderReady(TARGET);
    expect(screen.getByTestId('promote-section-stub').textContent).toBe('ready');
    cleanup();

    fns.saved = { data: savedView({ enabled: false, status: 'disabled' }), isLoading: false };
    await renderReady(TARGET);
    expect(screen.getByTestId('promote-section-stub').textContent).toBe('Turn the tool on to promote it.');
    cleanup();

    fns.saved = { data: newerVersion(), isLoading: false };
    await renderReady({ artifactId: 'artifact-1', version: 4, blocked: null });
    expect(screen.getByTestId('promote-section-stub').textContent).toBe(
      'Promotion runs the saved version 3. Update the tool to promote this version.'
    );
  });

  it('live: says so in the status, and shows no promotion once the artifact is deleted', async () => {
    fns.saved = { data: savedView({ state: 'live', status: 'live' }), isLoading: false };
    await renderReady(TARGET);
    expect(statusText()).toBe('Live tool, pinned to version 3.');
    expect(screen.getByTestId('python-function-offer-cap').textContent).toBe(
      'Chat and agent runs offer up to 20 of your live tools, oldest first.'
    );
    cleanup();

    fns.saved = { data: savedView({ status: 'source_deleted' }), isLoading: false };
    await renderReady(TARGET);
    expect(screen.queryByTestId('promote-section-stub')).toBeNull();
    expect(screen.queryByTestId('python-function-offer-cap')).toBeNull();
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

  it('shows when chat runs the tool and sets Always ask', async () => {
    fns.saved = { data: savedView(), isLoading: false };
    await renderReady(TARGET);

    const select = screen.getByTestId('python-function-approval');
    expect(select.textContent).toBe('Run without asking');
    fireEvent.click(select);
    fireEvent.click(await screen.findByTestId('python-function-approval-always_ask'));

    expect(fns.setApproval.mutate).toHaveBeenCalledWith({ id: 'fn-1', approval: 'always_ask' }, expect.anything());
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

  it('the delete confirm is an alert dialog named by its title', async () => {
    fns.saved = { data: savedView(), isLoading: false };
    await renderReady(TARGET);

    fireEvent.click(screen.getByTestId('python-function-delete-btn'));

    expect(screen.getByRole('alertdialog', { name: 'Delete this tool?' })).toBe(
      screen.getByTestId('python-function-delete-dialog')
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

  describe('an update refused as breaking', () => {
    const refusal = () =>
      Object.assign(new Error('Request failed with status code 409'), {
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: 'This version changes the contract in a way that could break callers of the tool.',
            code: 'breaking_change',
            changes: [
              {
                path: 'inputs.load.unit',
                side: 'inputs',
                field: 'load',
                kind: 'unit_changed',
                before: 'N',
                after: 'kN',
              },
              { path: 'outputs.deflection', side: 'outputs', field: 'deflection', kind: 'removed' },
            ],
          },
        },
      });

    const refuseUpdate = async (error: unknown) => {
      fns.saved = { data: newerVersion(), isLoading: false };
      await renderReady({ artifactId: 'artifact-1', version: 4, blocked: null });
      fireEvent.click(screen.getByTestId('python-function-repin-btn'));
      const [, callbacks] = fns.repin.mutate.mock.calls[0] as [unknown, { onError: (error: unknown) => void }];
      act(() => callbacks.onError(error));
    };

    it('lists each change in plain words and offers saving as a new tool, with no override', async () => {
      await refuseUpdate(refusal());

      const dialog = await screen.findByTestId('breaking-change-dialog');
      expect(
        within(dialog)
          .getAllByTestId('breaking-change-dialog-change')
          .map(item => item.textContent)
      ).toEqual(['input load changed unit from N to kN', 'output deflection was removed']);
      expect(dialog.textContent).toContain(
        'changes the contract of beam_midspan_deflection in ways that could break its callers, so the tool stays pinned to version 3.'
      );
      expect(within(dialog).getByTestId('breaking-change-dialog-offer').textContent).toBe(
        'To save version 4 as a new tool and keep beam_midspan_deflection as it is, give it a new name in FUNCTION, save the artifact, and select Make this a tool.'
      );
      expect(
        within(dialog)
          .getAllByRole('button')
          .map(button => button.textContent)
      ).toEqual(['', 'Close']);
      expect(fns.toastError).not.toHaveBeenCalled();
      expect(fns.remove.mutate).not.toHaveBeenCalled();
      expect(fns.repin.mutate).toHaveBeenCalledTimes(1);

      fireEvent.click(within(dialog).getByTestId('breaking-change-dialog-close-btn'));
      await waitFor(() => expect(screen.queryByTestId('breaking-change-dialog')).toBeNull());
      expect(statusText()).toBe(
        'A newer version is available. This tool is pinned to version 3, and the artifact is at version 4.'
      );
    });

    it('for a promoted tool, names the promotion and offers no way to update to a version promotion refuses', async () => {
      const promotedRefusal = refusal();
      Object.assign(promotedRefusal.response.data, { promotedSeq: 2 });
      await refuseUpdate(promotedRefusal);

      const dialog = await screen.findByTestId('breaking-change-dialog');
      expect(within(dialog).getByTestId('breaking-change-dialog-promoted').textContent).toBe(
        'Version 4 changes the contract of beam_midspan_deflection since promotion 2 in ways that could break its callers. A promoted tool cannot be moved to a version promotion would refuse, so the tool stays pinned to version 3.'
      );
      expect(within(dialog).queryByTestId('breaking-change-dialog-accept-btn')).toBeNull();
      expect(dialog.textContent).not.toContain('Update anyway');
      expect(fns.repin.mutate).toHaveBeenCalledTimes(1);
    });

    it('any other refusal stays a toast', async () => {
      await refuseUpdate(axiosError(409, 'The artifact changed since you opened it. Reload it and try again.'));

      expect(fns.toastError).toHaveBeenCalledWith('Could not update the tool.', {
        description: 'The artifact changed since you opened it. Reload it and try again.',
      });
      expect(screen.queryByTestId('breaking-change-dialog')).toBeNull();
    });

    it('gives two values added to one output enum their own rows', async () => {
      const added = (value: string) => ({
        path: 'outputs.grade.enum',
        side: 'outputs',
        field: 'grade',
        kind: 'enum_value_added',
        after: value,
      });
      const error = refusal();
      error.response.data.changes = [added('B'), added('C')] as never;
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      await refuseUpdate(error);

      const dialog = await screen.findByTestId('breaking-change-dialog');
      expect(
        within(dialog)
          .getAllByTestId('breaking-change-dialog-change')
          .map(item => item.textContent)
      ).toEqual(['output grade can now return B', 'output grade can now return C']);
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
      consoleError.mockRestore();
    });

    it('after Close, puts focus back on Update', async () => {
      await refuseUpdate(refusal());

      const dialog = await screen.findByTestId('breaking-change-dialog');
      fireEvent.click(within(dialog).getByTestId('breaking-change-dialog-close-btn'));

      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('python-function-repin-btn')));
    });

    it('a saved contract that cannot be read says so in plain words, with no list', async () => {
      await refuseUpdate(
        Object.assign(new Error('Request failed with status code 409'), {
          isAxiosError: true,
          response: {
            status: 409,
            data: {
              error: 'The saved contract cannot be read; save this version as a new tool.',
              code: 'contract_unreadable',
            },
          },
        })
      );

      const dialog = await screen.findByTestId('breaking-change-dialog');
      expect(within(dialog).getByText('This tool cannot be updated')).toBeTruthy();
      expect(within(dialog).getByTestId('breaking-change-dialog-unreadable').textContent).toBe(
        'The saved contract cannot be read; save this version as a new tool.'
      );
      expect(within(dialog).queryByTestId('breaking-change-dialog-changes')).toBeNull();
      expect(within(dialog).getByTestId('breaking-change-dialog-offer')).toBeTruthy();
      expect(fns.toastError).not.toHaveBeenCalled();
    });
  });

  describe('other tools saved from the artifact', () => {
    const renamed = () => ({ ...sampleContract(), name: 'beam_midspan_deflection_v2' });
    const VERSION_4: PythonFunctionSave = { artifactId: 'artifact-1', version: 4, blocked: null };

    const renderRenamed = async () => {
      callFunction.mockResolvedValueOnce(described(renamed()));
      const { rerender } = renderPanel(false, VERSION_4);
      await screen.findByTestId('python-function-contract-inputs', {}, { timeout: 2000 });
      return { rerender: () => rerender(false) };
    };

    const otherTool = () => screen.getByTestId('python-function-other-tool');

    it('once FUNCTION has a new name, offers Make this a tool and lists the old tool with its status and controls', async () => {
      fns.others = [savedView({ enabled: false, status: 'disabled' })];
      await renderRenamed();

      expect(fns.query).toHaveBeenLastCalledWith('artifact-1', 4, 'beam_midspan_deflection_v2');
      const save = screen.getByTestId('python-function-save-btn');
      const others = screen.getByTestId('python-function-other-tools');
      expect(follows(others, save)).toBe(true);
      expect(others.textContent).toContain('Other tools saved from this artifact:');
      expect(within(otherTool()).getByText('beam_midspan_deflection')).toBeTruthy();
      expect(within(otherTool()).getByTestId('python-function-other-tool-status').textContent).toBe(
        'This tool is turned off.Saved as a draft tool, pinned to version 3.'
      );
      expect(within(otherTool()).getByTestId('python-function-other-tool-enable-btn').textContent).toBe('Turn on');
      expect(within(otherTool()).getByTestId('python-function-other-tool-delete-btn').textContent).toBe('Delete');
    });

    it('lists them under the saved tool too', async () => {
      fns.saved = { data: savedView(), isLoading: false };
      fns.others = [savedView({ id: 'fn-2', slug: 'beam_midspan_deflection_v2' })];
      await renderReady(TARGET);

      expect(statusText()).toBe('Saved as a draft tool, pinned to version 3.');
      expect(within(otherTool()).getByText('beam_midspan_deflection_v2')).toBeTruthy();
    });

    it('Turn off turns the other tool off and keeps focus on its button', async () => {
      fns.others = [savedView()];
      await renderRenamed();

      const toggle = within(otherTool()).getByTestId('python-function-other-tool-enable-btn');
      expect(toggle.textContent).toBe('Turn off');
      fireEvent.click(toggle);

      const [input, callbacks] = fns.setEnabled.mutate.mock.calls[0] as [unknown, { onSettled: () => void }];
      expect(input).toEqual({ id: 'fn-1', enabled: false });
      act(() => callbacks.onSettled());
      await waitFor(() => expect(document.activeElement).toBe(toggle));
    });

    it('Delete asks first with the same dialog, deletes the other tool, and focuses Make this a tool', async () => {
      fns.others = [savedView()];
      const { rerender } = await renderRenamed();

      fireEvent.click(within(otherTool()).getByTestId('python-function-other-tool-delete-btn'));
      const dialog = screen.getByTestId('python-function-delete-dialog');
      expect(dialog.textContent).toContain(
        'This deletes the tool beam_midspan_deflection. The artifact is not changed.'
      );
      expect(fns.remove.mutate).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByTestId('python-function-delete-confirm-btn'));
      const [id, callbacks] = fns.remove.mutate.mock.calls[0] as [
        string,
        { onSuccess: () => void; onSettled: () => void },
      ];
      expect(id).toBe('fn-1');
      act(() => {
        callbacks.onSuccess();
        callbacks.onSettled();
      });
      fns.others = [];
      rerender();

      expect(screen.queryByTestId('python-function-other-tools')).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('python-function-save-btn')));
    });

    it('names each tool on its Turn off and Delete buttons, and deletes the tool whose button was clicked', async () => {
      fns.saved = { data: savedView(), isLoading: false };
      fns.others = [savedView({ id: 'fn-2', slug: 'beam_midspan_deflection_v2' })];
      await renderReady(TARGET);

      expect(screen.getByRole('button', { name: 'Turn off beam_midspan_deflection' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Turn off beam_midspan_deflection_v2' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Delete beam_midspan_deflection' })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Delete beam_midspan_deflection_v2' }));
      const dialog = screen.getByRole('alertdialog');
      expect(dialog.textContent).toContain('This deletes the tool beam_midspan_deflection_v2.');
      fireEvent.click(within(dialog).getByTestId('python-function-delete-confirm-btn'));

      expect(fns.remove.mutate).toHaveBeenCalledTimes(1);
      expect(fns.remove.mutate.mock.calls[0][0]).toBe('fn-2');
    });

    it('names a turned-off tool on its Turn on button', async () => {
      fns.others = [savedView({ enabled: false, status: 'disabled' })];
      await renderRenamed();

      expect(screen.getByRole('button', { name: 'Turn on beam_midspan_deflection' })).toBeTruthy();
    });

    it('shows none when the artifact has no other tools', async () => {
      await renderRenamed();

      expect(screen.getByTestId('python-function-save-btn')).toBeTruthy();
      expect(screen.queryByTestId('python-function-other-tools')).toBeNull();
    });
  });
});
