import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';

import { getThemeConfig } from '@client/app/utils/themes';
import type { IAgentStep } from '@bike4mind/common';
import IterationStep, { isErrorObservation } from './IterationStep';

/**
 * Covers the tool-error observation treatment (issue #653): a recovered error
 * reads as a calm, collapsed "Retried" note; a fatal error (run failed) stays
 * expanded and danger-toned; normal steps are untouched.
 */

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  React.createElement(CssVarsProvider, { theme: appTheme }, children);

const step = (over: Partial<IAgentStep> = {}): IAgentStep => ({
  type: 'observation',
  content: 'ok result',
  metadata: { timestamp: 1, toolName: 'optihashi_formulate' },
  ...over,
});

const ERROR = 'Error: Could not parse the model response as JSON.\n\nPlease rephrase with more specifics.';

describe('isErrorObservation', () => {
  it('matches an observation whose content starts with "Error:"', () => {
    expect(isErrorObservation(step({ content: ERROR }))).toBe(true);
    expect(isErrorObservation(step({ content: '  Error: leading whitespace' }))).toBe(true);
  });
  it('does not match a normal observation or a non-observation containing "Error:"', () => {
    expect(isErrorObservation(step({ content: 'sourced instance ok' }))).toBe(false);
    expect(isErrorObservation(step({ type: 'action', content: 'Error: not an observation' }))).toBe(false);
    expect(isErrorObservation(step({ type: 'thought', content: 'thinking about the Error: case' }))).toBe(false);
  });
});

describe('IterationStep - tool-error observation', () => {
  it('recovered (default): shows a "Retried" chip and collapses the error detail', () => {
    render(<IterationStep step={step({ content: ERROR })} />, { wrapper: Wrapper });
    expect(screen.getByText('Retried')).toBeTruthy();
    expect(screen.getByText(/the agent hit a tool error here and retried/i)).toBeTruthy();
    // Detail hidden until expanded.
    expect(screen.queryByText(/Could not parse the model response/)).toBeNull();
    const box = screen.getByTestId('iteration-step-observation');
    expect(box.getAttribute('data-error-tone')).toBe('recovered');
  });

  it('recovered: "Show detail" reveals the raw error, "Hide detail" collapses it again', () => {
    render(<IterationStep step={step({ content: ERROR })} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('iteration-step-observation-toggle'));
    expect(screen.getByText(/Could not parse the model response/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('iteration-step-observation-toggle'));
    expect(screen.queryByText(/Could not parse the model response/)).toBeNull();
  });

  it('fatal (recovered=false): shows a "Tool error" chip with the detail expanded', () => {
    render(<IterationStep step={step({ content: ERROR })} recovered={false} />, { wrapper: Wrapper });
    expect(screen.getByText('Tool error')).toBeTruthy();
    expect(screen.getByText(/Could not parse the model response/)).toBeTruthy();
    const box = screen.getByTestId('iteration-step-observation');
    expect(box.getAttribute('data-error-tone')).toBe('fatal');
  });

  it('a normal observation is unaffected by the error treatment', () => {
    render(<IterationStep step={step({ content: 'sourced instance ok' })} recovered={false} />, { wrapper: Wrapper });
    expect(screen.getByText('Observation')).toBeTruthy();
    expect(screen.getByText('sourced instance ok')).toBeTruthy();
    expect(screen.queryByText('Retried')).toBeNull();
    expect(screen.queryByText('Tool error')).toBeNull();
  });
});
