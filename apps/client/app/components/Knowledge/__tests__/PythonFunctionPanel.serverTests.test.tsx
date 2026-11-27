import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const callFunction = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/usePyodide', () => ({ usePyodide: () => ({ callFunction }) }));

const h = vi.hoisted(() => ({
  saved: null as unknown,
  runTests: vi.fn(),
  pending: false,
  runtime: true,
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
vi.mock('@client/app/hooks/data/callableFunctions', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/callableFunctions')>()),
  useArtifactCallableFunction: () => ({ isLoading: false, data: { saved: h.saved, others: [] } }),
  useRepinCallableFunction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetCallableFunctionEnabled: () => ({ mutate: vi.fn(), isPending: false }),
  useSetCallableFunctionApproval: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCallableFunction: () => ({ mutate: vi.fn(), isPending: false }),
  useRunCallableFunctionTests: () => ({ mutate: h.runTests, isPending: h.pending }),
  useCallableFunctionsServerRuntime: () => h.runtime,
}));
vi.mock('../SaveFunctionDialog', () => ({ default: () => <div data-testid="save-function-dialog" /> }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('../PromoteFunctionSection', () => ({ default: () => null }));
vi.mock('../FunctionDataSection', () => ({ default: () => null }));
vi.mock('../FunctionSourcesSection', () => ({ default: () => null }));

import PythonFunctionPanel, { type PythonFunctionSave } from '../PythonFunctionPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const CODE = 'FUNCTION = {...}\n\ndef run(span):\n    return {}';
const TARGET: PythonFunctionSave = { artifactId: 'artifact-1', version: 3, blocked: null };

const CONTRACT = {
  name: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam.',
  inputs: {
    type: 'object',
    additionalProperties: false,
    required: ['span'],
    properties: { span: { type: 'number', unit: 'm', exclusiveMinimum: 0 } },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['deflection'],
    properties: { deflection: { type: 'number', unit: 'm' } },
  },
  tests: [
    { name: 'short span', input: { span: 2 }, expected: { deflection: 4 } },
    { name: 'long span', input: { span: 10 }, expected: { deflection: 20 } },
  ],
};

const savedView = (overrides: Record<string, unknown> = {}) => ({
  id: 'fn-1',
  slug: CONTRACT.name,
  description: CONTRACT.description,
  status: 'draft',
  state: 'draft',
  enabled: true,
  pin: { artifactId: 'artifact-1', version: 3, contentHash: 'a'.repeat(64), pinnedAt: '2026-11-22T10:00:00.000Z' },
  latestVersion: 3,
  updateAvailable: false,
  createdAt: '2026-11-22T10:00:00.000Z',
  updatedAt: '2026-11-22T10:00:00.000Z',
  ...overrides,
});

const caseResult = (overrides: Record<string, unknown>) => ({
  passed: true,
  outcome: 'ok',
  mismatch: null,
  durationMs: 41,
  callId: 'call-1',
  ...overrides,
});

const panel = (code = CODE, save: PythonFunctionSave = TARGET) => (
  <CssVarsProvider theme={appTheme}>
    <PythonFunctionPanel sandboxOwner="artifact-1" code={code} packages={[]} disabled={false} save={save} />
  </CssVarsProvider>
);

const renderPanel = async () => {
  callFunction.mockResolvedValueOnce({ success: true, contract: CONTRACT, output: '', executionTime: 4 });
  render(panel());
  return screen.findByTestId('python-function-tests', {}, { timeout: 2000 });
};

const serverButton = () => screen.getByTestId('python-function-tests-server-run-btn') as HTMLButtonElement;
const cells = (testId: string) => screen.getAllByTestId(testId).map(cell => cell.textContent);

/** Answers the next server run with `run`, the way react-query calls onSuccess. */
const answerWith = (run: unknown) =>
  h.runTests.mockImplementationOnce((_request: unknown, handlers: { onSuccess: (data: unknown) => void }) =>
    handlers.onSuccess(run)
  );

beforeEach(() => {
  callFunction.mockReset();
  h.runTests.mockReset();
  h.saved = savedView();
  h.pending = false;
  h.runtime = true;
});

describe('PythonFunctionPanel server tests', () => {
  it('holds server tests after reading an edited contract until it is saved and repinned', async () => {
    callFunction.mockResolvedValueOnce({ success: true, contract: CONTRACT, output: '', executionTime: 4 });
    const view = render(panel());
    await screen.findByTestId('python-function-tests', {}, { timeout: 2000 });
    answerWith({
      functionId: 'fn-1',
      passed: 1,
      failed: 0,
      notRun: 1,
      results: [
        caseResult({ name: 'short span' }),
        { name: 'long span', passed: false, outcome: 'not_run', reason: 'budget_exhausted', mismatch: null },
      ],
    });
    fireEvent.click(serverButton());
    await waitFor(() => expect(cells('python-function-test-server-status')).toEqual(['Passed', 'Not run']));
    const editedCode = `${CODE}\n# edited expected value`;
    const editedContract = {
      ...CONTRACT,
      tests: [{ ...CONTRACT.tests[0], expected: { deflection: 5 } }, CONTRACT.tests[1]],
    };
    callFunction.mockResolvedValueOnce({ success: true, contract: editedContract, output: '', executionTime: 4 });
    const blocked = { ...TARGET, blocked: 'Save your edits before running server tests.' };
    view.rerender(panel(editedCode, blocked));
    await waitFor(() => expect(callFunction).toHaveBeenCalledWith(editedCode, null, []));
    await screen.findByTestId('python-function-tests-server-run-btn', {}, { timeout: 2000 });
    expect(serverButton().disabled).toBe(true);
    expect(cells('python-function-test-server-status')).not.toContain('Passed');
    expect(screen.queryByTestId('python-function-tests-server-not-run')).toBeNull();
    expect(screen.queryByTestId('python-function-test-server-status-ms')).toBeNull();
    fireEvent.click(serverButton());
    expect(h.runTests).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId('python-function-tests-server-note').textContent).toBe(blocked.blocked)
    );
    view.rerender(panel(editedCode, { ...TARGET, version: 4 }));
    expect(serverButton().disabled).toBe(true);
    h.saved = savedView({ pin: { ...savedView().pin, version: 4 } });
    view.rerender(panel(editedCode, { ...TARGET, version: 4 }));
    expect(serverButton().disabled).toBe(false);
    expect(cells('python-function-test-server-status')).not.toContain('Passed');
  });

  it('does not paint a pending or late saved response onto edited code', async () => {
    callFunction.mockResolvedValueOnce({ success: true, contract: CONTRACT, output: '', executionTime: 4 });
    const view = render(panel());
    await screen.findByTestId('python-function-tests', {}, { timeout: 2000 });
    let complete: ((data: unknown) => void) | undefined;
    h.runTests.mockImplementationOnce((_request: unknown, handlers: { onSuccess: (data: unknown) => void }) => {
      complete = handlers.onSuccess;
    });
    fireEvent.click(serverButton());
    h.pending = true;
    view.rerender(panel(CODE, { ...TARGET, blocked: 'Save your edits before running server tests.' }));
    expect(cells('python-function-test-server-status')).not.toContain('Running');
    expect(complete).toBeDefined();
    act(() =>
      complete?.({
        functionId: 'fn-1',
        passed: 2,
        failed: 0,
        results: [caseResult({ name: 'short span' }), caseResult({ name: 'long span' })],
      })
    );
    expect(cells('python-function-test-server-status')).not.toContain('Passed');
    expect(screen.queryByTestId('python-function-test-server-status-ms')).toBeNull();
    expect(serverButton().disabled).toBe(true);
  });

  it('shows the browser and server results side by side, each with its timing', async () => {
    const section = await renderPanel();
    callFunction
      .mockResolvedValueOnce({ success: true, value: { deflection: 4 }, output: '', executionTime: 12 })
      .mockResolvedValueOnce({ success: true, value: { deflection: 20 }, output: '', executionTime: 9 });
    fireEvent.click(within(section).getByTestId('python-function-tests-run-btn'));
    await waitFor(() => expect(cells('python-function-test-status')).toEqual(['Passed', 'Passed']));

    answerWith({
      functionId: 'fn-1',
      passed: 2,
      failed: 0,
      results: [
        caseResult({ name: 'short span', durationMs: 41, callId: 'call-1' }),
        caseResult({ name: 'long span', durationMs: 38, callId: 'call-2' }),
      ],
    });
    fireEvent.click(serverButton());

    expect(h.runTests).toHaveBeenCalledWith({ id: 'fn-1' }, expect.any(Object));
    expect(
      within(section)
        .getAllByRole('columnheader')
        .map(th => th.textContent)
    ).toEqual(['Test', 'Browser', 'Server']);
    await waitFor(() => expect(cells('python-function-test-server-status')).toEqual(['Passed', 'Passed']));
    expect(cells('python-function-test-status-ms')).toEqual([' (12 ms)', ' (9 ms)']);
    expect(cells('python-function-test-server-status-ms')).toEqual([' (41 ms)', ' (38 ms)']);
    expect(screen.queryByTestId('python-function-test-server-failure')).toBeNull();
  });

  it('names the failing field and both values on the server side, and a timeout by name', async () => {
    await renderPanel();
    answerWith({
      functionId: 'fn-1',
      passed: 0,
      failed: 2,
      results: [
        caseResult({
          name: 'short span',
          passed: false,
          mismatch: { path: 'deflection', expected: 4, actual: 5 },
        }),
        caseResult({ name: 'long span', passed: false, outcome: 'timeout', durationMs: 30_000 }),
      ],
    });
    fireEvent.click(serverButton());

    await waitFor(() => expect(cells('python-function-test-server-status')).toEqual(['Failed', 'Timed out']));
    expect(screen.getAllByTestId('python-function-test-server-failure').map(alert => alert.textContent)).toEqual([
      'short span: output deflection expected 4, got 5.',
      'long span: stopped at the time limit.',
    ]);
  });

  it('marks every server cell running while the request is in flight', async () => {
    h.pending = true;
    await renderPanel();
    expect(cells('python-function-test-server-status')).toEqual(['Running', 'Running']);
    expect(serverButton().disabled).toBe(true);
  });

  it('shows the error the server returned', async () => {
    await renderPanel();
    h.runTests.mockImplementationOnce((_request: unknown, handlers: { onError: (error: unknown) => void }) =>
      handlers.onError(
        Object.assign(new Error('Request failed with status code 422'), {
          isAxiosError: true,
          response: { status: 422, data: { error: 'The server could not read the function contract.' } },
        })
      )
    );
    fireEvent.click(serverButton());
    expect((await screen.findByTestId('python-function-tests-server-error')).textContent).toBe(
      'The server could not read the function contract.'
    );
  });

  it.each([
    ['no saved tool', null, 'Save this version as a tool to run its tests on the server.'],
    [
      'a turned-off tool',
      savedView({ status: 'disabled', enabled: false }),
      'Turn the tool on to run its tests on the server.',
    ],
    [
      'a tool pinned to another version',
      savedView({ pin: { ...savedView().pin, version: 2 } }),
      'The server runs the saved version 2. Update the tool to test this version there.',
    ],
    [
      'a tool whose artifact was deleted',
      savedView({ status: 'source_deleted' }),
      'The artifact behind this tool was deleted.',
    ],
  ])('holds the server button for %s and says why', async (_name, saved, note) => {
    h.saved = saved;
    await renderPanel();
    expect(serverButton().disabled).toBe(true);
    expect(screen.getByTestId('python-function-tests-server-note').textContent).toBe(note);
  });

  it('holds the server button on a stage with no server runtime', async () => {
    h.runtime = false;
    await renderPanel();
    expect(serverButton().disabled).toBe(true);
    expect(screen.getByTestId('python-function-tests-server-note').textContent).toBe(
      'Server test runs are not set up here.'
    );
  });

  it('pairs server results with the tests by name, whatever order they come back in', async () => {
    await renderPanel();
    answerWith({
      functionId: 'fn-1',
      passed: 1,
      failed: 1,
      notRun: 0,
      results: [
        caseResult({ name: 'long span', passed: false, outcome: 'timeout', durationMs: 30_000 }),
        caseResult({ name: 'short span', durationMs: 41 }),
      ],
    });
    fireEvent.click(serverButton());
    await waitFor(() => expect(cells('python-function-test-server-status')).toEqual(['Passed', 'Timed out']));
    expect(screen.getByTestId('python-function-test-server-failure').textContent).toBe(
      'long span: stopped at the time limit.'
    );
  });

  it('shows the cases the budget left not run and runs only those on request', async () => {
    await renderPanel();
    answerWith({
      functionId: 'fn-1',
      passed: 1,
      failed: 0,
      notRun: 1,
      results: [
        caseResult({ name: 'short span', durationMs: 41 }),
        { name: 'long span', passed: false, outcome: 'not_run', reason: 'budget_exhausted', mismatch: null },
      ],
    });
    fireEvent.click(serverButton());
    await waitFor(() => expect(cells('python-function-test-server-status')).toEqual(['Passed', 'Not run']));
    expect(cells('python-function-test-server-status-ms')).toEqual([' (41 ms)']);
    expect(screen.queryByTestId('python-function-test-server-failure')).toBeNull();
    expect(screen.getByTestId('python-function-tests-server-not-run').textContent).toBe(
      '1 test did not fit in the time for one server run.'
    );

    answerWith({
      functionId: 'fn-1',
      passed: 1,
      failed: 0,
      notRun: 0,
      results: [caseResult({ name: 'long span', durationMs: 38, callId: 'call-2' })],
    });
    fireEvent.click(screen.getByTestId('python-function-tests-server-run-remaining-btn'));
    expect(h.runTests).toHaveBeenLastCalledWith({ id: 'fn-1', tests: ['long span'] }, expect.any(Object));
    await waitFor(() => expect(cells('python-function-test-server-status')).toEqual(['Passed', 'Passed']));
    expect(cells('python-function-test-server-status-ms')).toEqual([' (41 ms)', ' (38 ms)']);
    expect(screen.queryByTestId('python-function-tests-server-not-run')).toBeNull();
  });

  it('keeps the earlier results and shows the reason when running the remaining tests fails', async () => {
    await renderPanel();
    answerWith({
      functionId: 'fn-1',
      passed: 1,
      failed: 0,
      notRun: 1,
      results: [
        caseResult({ name: 'short span', durationMs: 41 }),
        { name: 'long span', passed: false, outcome: 'not_run', reason: 'budget_exhausted', mismatch: null },
      ],
    });
    fireEvent.click(serverButton());
    await waitFor(() => expect(cells('python-function-test-server-status')).toEqual(['Passed', 'Not run']));

    h.runTests.mockImplementationOnce((_request: unknown, handlers: { onError: (error: unknown) => void }) =>
      handlers.onError(
        Object.assign(new Error('Request failed with status code 503'), {
          isAxiosError: true,
          response: { status: 503, data: { error: 'The server runtime did not answer. Try again.' } },
        })
      )
    );
    fireEvent.click(screen.getByTestId('python-function-tests-server-run-remaining-btn'));
    expect((await screen.findByTestId('python-function-tests-server-error')).textContent).toBe(
      'The server runtime did not answer. Try again.'
    );
    expect(cells('python-function-test-server-status')).toEqual(['Passed', 'Not run']);
    expect(cells('python-function-test-server-status-ms')).toEqual([' (41 ms)']);
  });

  it('shows the runtime-starting answer as the server gave it', async () => {
    await renderPanel();
    h.runTests.mockImplementationOnce((_request: unknown, handlers: { onError: (error: unknown) => void }) =>
      handlers.onError(
        Object.assign(new Error('Request failed with status code 503'), {
          isAxiosError: true,
          response: {
            status: 503,
            data: { error: 'The runtime is starting. Try again in a minute.', code: 'runtime_starting' },
          },
        })
      )
    );
    fireEvent.click(serverButton());
    expect((await screen.findByTestId('python-function-tests-server-error')).textContent).toBe(
      'The runtime is starting. Try again in a minute.'
    );
    expect(serverButton().disabled).toBe(false);
  });

  it('offers no server column without save controls', async () => {
    callFunction.mockResolvedValueOnce({ success: true, contract: CONTRACT, output: '', executionTime: 4 });
    render(
      <CssVarsProvider theme={appTheme}>
        <PythonFunctionPanel sandboxOwner="artifact-1" code={CODE} packages={[]} disabled={false} save={null} />
      </CssVarsProvider>
    );
    const section = await screen.findByTestId('python-function-tests', {}, { timeout: 2000 });
    expect(within(section).queryByTestId('python-function-tests-server-run-btn')).toBeNull();
    expect(
      within(section)
        .getAllByRole('columnheader')
        .map(th => th.textContent)
    ).toEqual(['Test', 'Result']);
  });
});
