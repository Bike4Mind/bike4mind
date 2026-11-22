import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const callFunction = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/usePyodide', () => ({ usePyodide: () => ({ callFunction }) }));

import PythonFunctionPanel from '../PythonFunctionPanel';

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
  tests: [
    {
      name: 'steel beam, 4 m span',
      input: { load: 1000, span: 4, elastic_modulus: 200e9, second_moment: 8e-6 },
      expected: { deflection: 0.00208333 },
      tolerance: { rel: 1e-5 },
    },
  ],
});

const described = (contract: unknown = sampleContract()) => ({
  success: true,
  contract,
  output: '',
  executionTime: 4,
});

const renderPanel = (disabled = false) => {
  const view = render(
    <CssVarsProvider theme={appTheme}>
      <PythonFunctionPanel code={CODE} packages={[]} disabled={disabled} />
    </CssVarsProvider>
  );
  const rerender = (nextDisabled: boolean) =>
    view.rerender(
      <CssVarsProvider theme={appTheme}>
        <PythonFunctionPanel code={CODE} packages={[]} disabled={nextDisabled} />
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
    expect(screen.getByText('1 test case declared.')).toBeTruthy();
    // Each numeric input carries its unit beside it.
    const spanControl = screen.getByTestId('python-function-input-span').parentElement as HTMLElement;
    expect(within(spanControl).getByText('m')).toBeTruthy();
    expect(screen.getByText('Calls run in your browser. Nothing is saved.')).toBeTruthy();
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
