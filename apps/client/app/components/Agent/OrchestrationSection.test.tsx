/**
 * Focused behavioral tests for OrchestrationSection.
 *
 * Coverage is intentionally narrow - these tests guard the four properties
 * that, if broken, would silently change the meaning of the form:
 *
 *  1. The section is collapsed by default (no fields visible without click).
 *  2. The "ReAct enabled" chip in the header only appears when the agent IS
 *     orchestration-configured. This chip is the user's at-a-glance signal
 *     that they've crossed into ReAct-mode authoring.
 *  3. Adding a default variable produces a stable id (key edits don't
 *     unmount the row).
 *  4. Removing a default variable filters by id, not by position.
 *
 * Field-level rendering and tool-picker behavior are covered by the E2E test
 * guide rather than RTL - Joy's Select uses portals + virtual lists that don't
 * replay reliably under jsdom.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';

import OrchestrationSection from './OrchestrationSection';
import type { AgentOrchestration } from '../../types/agentForm';
import { DEFAULT_MAX_ITERATIONS } from '../../constants/agentForm';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

// useAccessibleModels reaches into context providers we don't want to bring
// up in a unit test. The model picker isn't under test here - we just need it
// to render without throwing. Mock path must match the importer's relative
// path (vitest's mock resolution is path-literal-equal, not alias-aware).
vi.mock('../../hooks/useAccessibleModels', () => ({
  useAccessibleModels: () => ({ accessibleTextModels: [] }),
}));

// The section references custom palette tokens (border.soft, background.body)
// defined in the app's theme primitives. Plain CssVarsProvider would throw
// at render time on first sx-token lookup.
const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const emptyOrchestration = (): AgentOrchestration => ({
  allowedTools: [],
  deniedTools: [],
  maxIterations: { ...DEFAULT_MAX_ITERATIONS },
  defaultThoroughness: '',
  defaultVariables: [],
  exclusiveMcpServers: [],
  fallbackModels: [],
});

describe('OrchestrationSection', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
  });

  it('renders collapsed by default with no fields visible', () => {
    render(
      <TestWrapper>
        <OrchestrationSection value={emptyOrchestration()} onChange={onChange} />
      </TestWrapper>
    );

    // Header is present
    expect(screen.getByTestId('orchestration-section-toggle')).toBeInTheDocument();
    // Fields are not - until the user clicks to expand
    expect(screen.queryByTestId('orchestration-allowed-tools-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('orchestration-default-thoroughness-select')).not.toBeInTheDocument();
  });

  it('does not show the "ReAct enabled" chip when fully unconfigured', () => {
    render(
      <TestWrapper>
        <OrchestrationSection value={emptyOrchestration()} onChange={onChange} />
      </TestWrapper>
    );

    expect(screen.queryByTestId('orchestration-section-active-chip')).not.toBeInTheDocument();
  });

  it('shows the "ReAct enabled" chip when any orchestration field is set', () => {
    const configured: AgentOrchestration = { ...emptyOrchestration(), allowedTools: ['web_search'] };

    render(
      <TestWrapper>
        <OrchestrationSection value={configured} onChange={onChange} />
      </TestWrapper>
    );

    const chip = screen.getByTestId('orchestration-section-active-chip');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent(/ReAct enabled/i);
  });

  it('reveals the field controls once the header is clicked', () => {
    render(
      <TestWrapper>
        <OrchestrationSection value={emptyOrchestration()} onChange={onChange} />
      </TestWrapper>
    );

    fireEvent.click(screen.getByTestId('orchestration-section-toggle'));

    expect(screen.getByTestId('orchestration-allowed-tools-select')).toBeInTheDocument();
    expect(screen.getByTestId('orchestration-denied-tools-select')).toBeInTheDocument();
    expect(screen.getByTestId('orchestration-default-thoroughness-select')).toBeInTheDocument();
    expect(screen.getByTestId('orchestration-max-iterations-quick-input')).toBeInTheDocument();
    expect(screen.getByTestId('orchestration-max-iterations-medium-input')).toBeInTheDocument();
    expect(screen.getByTestId('orchestration-max-iterations-very_thorough-input')).toBeInTheDocument();
    expect(screen.getByTestId('orchestration-add-variable-btn')).toBeInTheDocument();
  });

  it('emits a new defaultVariable entry with a stable id on add', () => {
    render(
      <TestWrapper>
        <OrchestrationSection value={emptyOrchestration()} onChange={onChange} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('orchestration-section-toggle'));

    fireEvent.click(screen.getByTestId('orchestration-add-variable-btn'));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as AgentOrchestration;
    expect(next.defaultVariables).toHaveLength(1);
    expect(next.defaultVariables[0].id).toEqual(expect.any(String));
    expect(next.defaultVariables[0].id.length).toBeGreaterThan(0);
    expect(next.defaultVariables[0].key).toBe('');
    expect(next.defaultVariables[0].value).toBe('');
  });

  it('removes a defaultVariable by id, not by index', () => {
    // Three rows; we remove the middle one. If the implementation filtered by
    // index, it would drop "row-1" instead of "row-mid".
    const value: AgentOrchestration = {
      ...emptyOrchestration(),
      defaultVariables: [
        { id: 'row-0', key: 'tone', value: 'formal' },
        { id: 'row-mid', key: 'mode', value: 'verbose' },
        { id: 'row-2', key: 'style', value: 'concise' },
      ],
    };

    render(
      <TestWrapper>
        <OrchestrationSection value={value} onChange={onChange} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('orchestration-section-toggle'));

    fireEvent.click(screen.getByTestId('orchestration-variable-remove-row-mid'));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as AgentOrchestration;
    expect(next.defaultVariables.map(v => v.id)).toEqual(['row-0', 'row-2']);
  });

  it('disables iteration inputs when no orchestration field is configured', () => {
    render(
      <TestWrapper>
        <OrchestrationSection value={emptyOrchestration()} onChange={onChange} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('orchestration-section-toggle'));

    for (const level of ['quick', 'medium', 'very_thorough']) {
      const wrapper = screen.getByTestId(`orchestration-max-iterations-${level}-input`);
      const input = within(wrapper).getByRole('spinbutton') as HTMLInputElement;
      expect(input).toBeDisabled();
    }
    expect(screen.getByTestId('orchestration-iterations-disabled-hint')).toBeInTheDocument();
  });

  it('enables iteration inputs when orchestration is configured', () => {
    const configured: AgentOrchestration = { ...emptyOrchestration(), allowedTools: ['web_search'] };

    render(
      <TestWrapper>
        <OrchestrationSection value={configured} onChange={onChange} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('orchestration-section-toggle'));

    for (const level of ['quick', 'medium', 'very_thorough']) {
      const wrapper = screen.getByTestId(`orchestration-max-iterations-${level}-input`);
      const input = within(wrapper).getByRole('spinbutton') as HTMLInputElement;
      expect(input).not.toBeDisabled();
    }
    expect(screen.queryByTestId('orchestration-iterations-disabled-hint')).not.toBeInTheDocument();
  });

  it('keeps iteration inputs disabled when only an empty variable row exists', () => {
    const withEmptyVariableRow: AgentOrchestration = {
      ...emptyOrchestration(),
      defaultVariables: [{ id: 'row-1', key: '', value: '' }],
    };

    render(
      <TestWrapper>
        <OrchestrationSection value={withEmptyVariableRow} onChange={onChange} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('orchestration-section-toggle'));

    for (const level of ['quick', 'medium', 'very_thorough']) {
      const wrapper = screen.getByTestId(`orchestration-max-iterations-${level}-input`);
      const input = within(wrapper).getByRole('spinbutton') as HTMLInputElement;
      expect(input).toBeDisabled();
    }
    expect(screen.getByTestId('orchestration-iterations-disabled-hint')).toBeInTheDocument();
  });

  it('clamps iteration input below the minimum bound', () => {
    render(
      <TestWrapper>
        <OrchestrationSection value={emptyOrchestration()} onChange={onChange} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('orchestration-section-toggle'));

    // The wrapper holds data-testid; the actual <input> is nested.
    const wrapper = screen.getByTestId('orchestration-max-iterations-quick-input');
    const input = within(wrapper).getByRole('spinbutton') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '0' } });

    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0] as AgentOrchestration;
    // Below-min input gets clamped to the lower bound (1), not accepted as 0.
    expect(next.maxIterations.quick).toBe(1);
  });
});
