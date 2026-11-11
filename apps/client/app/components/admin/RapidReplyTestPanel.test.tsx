import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ModelInfo } from '@bike4mind/common';
import type { RapidReplyTestResult } from './RapidReplyTestPanel';

// Read at render time, so a test can set what the last run returned or how it failed.
let lastResult: RapidReplyTestResult | undefined;
let runError: Error | null = null;
const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('@client/app/hooks/data/rapidReplyMutations', () => ({
  useTestConfiguration: () => ({
    mutateAsync: mocks.mutateAsync,
    isPending: false,
    error: runError,
    data: lastResult,
  }),
}));

import { RapidReplyTestPanel } from './RapidReplyTestPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const models = [
  { id: 'main-a', name: 'Main A' },
  { id: 'main-b', name: 'Main B' },
] as ModelInfo[];

const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <RapidReplyTestPanel models={models} />
    </CssVarsProvider>
  );

const pickModel = (name: string) => {
  fireEvent.click(within(screen.getByTestId('rapid-reply-test-model-select')).getByRole('combobox'));
  fireEvent.click(screen.getByRole('option', { name }));
};

const textarea = () => screen.getByTestId('rapid-reply-test-input').querySelector('textarea') as HTMLTextAreaElement;

const fullResult: RapidReplyTestResult = {
  success: true,
  message: 'Rapid Reply configuration test completed successfully',
  testResults: {
    enabled: true,
    configuration: {
      mainModel: 'main-a',
      rapidModel: 'fast-a',
      maxTokens: 100,
      responseStyle: 'auto',
      systemPrompt: 'Acknowledge briefly.',
      maxLatency: 1500,
    },
    performance: {
      ttfvt: 320,
      latency: 812,
      responseLength: 42,
      maxConfiguredLatency: 1500,
      estimatedCost: 0.00012,
      tokensUsed: 18,
      latencyCheck: { passed: true, message: 'Rapid reply latency 812ms is within limits' },
    },
    rapidReplyTest: {
      success: true,
      testInput: 'Hello',
      response: 'On it - checking that now!',
      responseLength: 42,
      responseWordCount: 6,
    },
    settings: { globalEnabled: true, transitionMode: 'replace', showIndicator: true, fallbackBehavior: 'continue' },
    prompts: { total: 2, active: 1, applicable: [{ id: 'p1', name: 'Coding', domains: ['code'] }] },
  },
  recommendations: ['Configuration looks good!'],
};

beforeEach(() => {
  lastResult = undefined;
  runError = null;
  mocks.mutateAsync.mockReset().mockResolvedValue({ success: true });
});

describe('RapidReplyTestPanel', () => {
  it('keeps Run test disabled, with the reason beside it, until a model is picked', () => {
    renderPanel();

    expect(screen.getByTestId('rapid-reply-run-test-btn')).toBeDisabled();
    expect(screen.getByText('Pick a main model to run a test.')).toBeTruthy();

    pickModel('Main A');

    expect(screen.getByTestId('rapid-reply-run-test-btn')).not.toBeDisabled();
    expect(screen.queryByText('Pick a main model to run a test.')).toBeNull();
  });

  it('runs the test with the picked model and message, then lists it under recent tests', async () => {
    renderPanel();
    expect(screen.queryByTestId('rapid-reply-test-history-table')).toBeNull();

    pickModel('Main A');
    fireEvent.change(textarea(), { target: { value: 'Hello there' } });
    fireEvent.click(screen.getByTestId('rapid-reply-run-test-btn'));

    expect(mocks.mutateAsync).toHaveBeenCalledWith({ mainModelId: 'main-a', testInput: 'Hello there' });
    const table = await screen.findByTestId('rapid-reply-test-history-table');
    expect(within(table).getByText('main-a')).toBeTruthy();
    expect(within(table).getByText('Passed')).toBeTruthy();
  });

  it('fills a sample message into the test input', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'What is the capital of France?' }));

    expect(textarea().value).toBe('What is the capital of France?');
  });

  it('restores the model and message from a recent test, and clears the list', async () => {
    renderPanel();
    pickModel('Main A');
    fireEvent.change(textarea(), { target: { value: 'First message' } });
    fireEvent.click(screen.getByTestId('rapid-reply-run-test-btn'));
    await screen.findByTestId('rapid-reply-test-history-table');

    fireEvent.change(textarea(), { target: { value: 'Something else' } });
    fireEvent.click(within(screen.getByTestId('rapid-reply-test-history-table')).getByText('main-a'));
    expect(textarea().value).toBe('First message');

    fireEvent.click(screen.getByTestId('rapid-reply-clear-history-btn'));
    expect(screen.queryByTestId('rapid-reply-test-history-table')).toBeNull();
  });

  it('keeps only the ten most recent tests, newest first', async () => {
    renderPanel();
    pickModel('Main A');

    for (let run = 1; run <= 11; run++) {
      mocks.mutateAsync.mockResolvedValueOnce({ success: run !== 11 });
      fireEvent.click(screen.getByTestId('rapid-reply-run-test-btn'));
      await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(run));
    }

    const table = await screen.findByTestId('rapid-reply-test-history-table');
    await waitFor(() => expect(within(table).getAllByText('main-a')).toHaveLength(10));
    expect(within(table).getAllByText(/Passed|Failed/)[0].textContent).toBe('Failed');
  });

  it('does not add a recent test when the run fails, and says why', async () => {
    mocks.mutateAsync.mockRejectedValue(new Error('Network down'));
    runError = new Error('Network down');
    renderPanel();
    pickModel('Main A');

    fireEvent.click(screen.getByTestId('rapid-reply-run-test-btn'));

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalled());
    expect(screen.getByTestId('rapid-reply-test-error').textContent).toContain('Network down');
    expect(screen.queryByTestId('rapid-reply-test-history-table')).toBeNull();
  });

  it('renders a full result from the fields the test endpoint returns', () => {
    lastResult = fullResult;
    renderPanel();

    const results = screen.getByTestId('rapid-reply-test-results');
    expect(within(results).getByTestId('rapid-reply-test-summary').textContent).toContain('completed successfully');
    const strip = within(results).getByTestId('admin-stat-strip');
    expect(strip.textContent).toContain('812 ms');
    expect(strip.textContent).toContain('320 ms');
    expect(within(results).getByText('Within limit')).toBeTruthy();
    expect(within(results).getByText('$0.0001')).toBeTruthy();
    expect(within(results).getByTestId('rapid-reply-test-response').textContent).toBe('On it - checking that now!');
    expect(within(results).getByText('42 characters, 6 words')).toBeTruthy();
    expect(within(results).getByText('Coding')).toBeTruthy();
    expect(within(results).getByTestId('rapid-reply-test-recommendations').textContent).toContain(
      'Configuration looks good!'
    );
    // No section nests a grey box: the only surfaces are the strip and the section cards.
    expect(results.querySelector('.MuiSheet-variantSoft')).toBeNull();
  });

  it('renders an early-return result with only the summary and recommendations', () => {
    lastResult = {
      success: false,
      message: 'Rapid Reply is currently disabled in settings',
      testResults: { enabled: false, reason: 'System disabled' },
      recommendations: ['Enable Rapid Reply in settings to test functionality'],
    };
    renderPanel();

    const results = screen.getByTestId('rapid-reply-test-results');
    expect(within(results).getByTestId('rapid-reply-test-summary').textContent).toBe(
      'Rapid Reply is currently disabled in settings'
    );
    expect(within(results).queryByTestId('admin-stat-strip')).toBeNull();
    expect(within(results).queryByText('Performance')).toBeNull();
    expect(within(results).queryByText('Configuration')).toBeNull();
    expect(within(results).getByTestId('rapid-reply-test-recommendations').textContent).toContain('Enable Rapid Reply');
  });

  it('shows the latency check as over the limit when it fails', () => {
    lastResult = {
      ...fullResult,
      testResults: {
        ...fullResult.testResults,
        performance: {
          ...fullResult.testResults!.performance,
          latencyCheck: { passed: false, message: 'Rapid reply latency 2400ms exceeds limit of 1500ms' },
        },
      },
    };
    renderPanel();

    expect(screen.getByText('Over limit')).toBeTruthy();
    expect(screen.getByText('Rapid reply latency 2400ms exceeds limit of 1500ms')).toBeTruthy();
  });
});
