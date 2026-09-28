import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import type { ContextBreakdown } from '@bike4mind/services';

const { mockUseQuestContextBreakdown } = vi.hoisted(() => ({ mockUseQuestContextBreakdown: vi.fn() }));
vi.mock('@client/app/hooks/data/quests', () => ({
  useQuestContextBreakdown: (...a: unknown[]) => mockUseQuestContextBreakdown(...a),
}));

import ContextBreakdownModal from './ContextBreakdownModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const breakdown: ContextBreakdown = {
  questId: 'quest-1',
  capturedAt: '2026-09-16T10:00:00.000Z',
  model: { id: 'claude-opus-4-8', backend: 'bedrock' },
  categories: {
    systemPrompt: 2882,
    systemPromptBilled: 4000,
    toolDefinitions: 900,
    attachedFiles: 0,
    conversationHistory: 1200,
    memory: 0,
    urlContent: 0,
    userMessage: 40,
    // Pre-change turn: the volume is unknown, so the row renders a dash rather than 0.
    lakeRetrieval: null,
  },
  layers: [
    { source: 'hardcoded', name: 'date_time_context', tokenCount: 60, wasIncluded: true },
    { source: 'admin', name: 'artifact_emission', tokenCount: 2822, wasIncluded: true },
    { source: 'session', name: 'session_prompt', tokenCount: 4744, wasIncluded: false, exclusionReason: 'token_limit' },
  ],
  tools: [{ name: 'search_knowledge_base', offered: true, invocations: 1, successes: 1, failures: 0, durationMs: 120 }],
  retrieval: { attempted: true, outcome: 'ok', surfaces: ['forced'], dataLakeTags: ['handbook'] },
  cache: { readTokens: 6000, writeTokens: 2000, hitRate: 0.75, settledBasis: 'provider' },
  window: { contextWindow: 200000, inputTokens: 7040, outputTokens: 512, maxOutputTokens: 8192, freeSpace: 184768 },
  promptFingerprint: '673d0e7009c5',
};

const renderModal = (open = true) =>
  render(
    <Wrapper>
      <ContextBreakdownModal questId="quest-1" open={open} onClose={vi.fn()} />
    </Wrapper>
  );

describe('ContextBreakdownModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuestContextBreakdown.mockReturnValue({ data: breakdown, isLoading: false, error: null });
  });

  it('lists the layers in the order the server delivered them, excluded ones included', () => {
    renderModal();

    const rows = screen.getByTestId('context-breakdown-layers-table').querySelectorAll('tbody tr');
    expect([...rows].map(row => row.querySelector('td')?.textContent)).toEqual([
      'date_time_context',
      'artifact_emission',
      'session_prompt',
    ]);
    expect(rows[2].textContent).toContain('token_limit');
  });

  it('shows the free space left in the window', () => {
    renderModal();

    expect(screen.getByTestId('context-breakdown-categories-table').textContent).toContain('184,768');
  });

  it('renders a recorded lake bucket as its own category row and bar segment', () => {
    mockUseQuestContextBreakdown.mockReturnValue({
      data: {
        ...breakdown,
        categories: { ...breakdown.categories, lakeRetrieval: 340, systemPromptBilled: 3660 },
      },
      isLoading: false,
      error: null,
    });
    renderModal();

    const rows = [...screen.getByTestId('context-breakdown-categories-table').querySelectorAll('tbody tr')];
    const lakeRow = rows.find(row => row.querySelector('td')?.textContent === 'Lake retrieval');
    expect(lakeRow?.querySelectorAll('td')[1].textContent).toBe('340');
    // The shared distribution bar colours and labels the same bucket.
    expect(screen.getByText('Lake: 340')).toBeTruthy();
  });

  it('renders an unknown lake bucket as a dash rather than a zero', () => {
    renderModal();

    const rows = [...screen.getByTestId('context-breakdown-categories-table').querySelectorAll('tbody tr')];
    const lakeRow = rows.find(row => row.querySelector('td')?.textContent === 'Lake retrieval');
    expect(lakeRow?.querySelectorAll('td')[1].textContent).toBe('-');
    // A zero-token segment would misreport "unknown" as "none", so it is omitted entirely.
    expect(screen.queryByText('Lake: 0')).toBeNull();
  });

  it('does not query while closed', () => {
    renderModal(false);

    expect(mockUseQuestContextBreakdown).toHaveBeenCalledWith('quest-1', false);
  });

  it('renders a turn that recorded no layers, tools or retrieval', () => {
    mockUseQuestContextBreakdown.mockReturnValue({
      data: { ...breakdown, layers: [], tools: [], retrieval: null, promptFingerprint: '' },
      isLoading: false,
      error: null,
    });
    renderModal();

    expect(screen.getByText('This turn recorded no per-layer detail.')).toBeTruthy();
    expect(screen.getByText('No tools were offered on this turn.')).toBeTruthy();
    expect(screen.getByText('No retrieval was recorded for this turn.')).toBeTruthy();
  });

  // #3055: count + reason next to the existing "lakes:" chip.
  it('shows the excluded-lakes chip when the turn recorded an access exclusion', () => {
    mockUseQuestContextBreakdown.mockReturnValue({
      data: { ...breakdown, retrieval: { ...breakdown.retrieval, excludedLakes: { count: 2, reason: 'access' } } },
      isLoading: false,
      error: null,
    });
    renderModal();

    expect(screen.getByTestId('context-breakdown-excluded-lakes-chip').textContent).toContain('excluded: 2 (access)');
  });

  it('omits the excluded-lakes chip when nothing was excluded', () => {
    renderModal();

    expect(screen.queryByTestId('context-breakdown-excluded-lakes-chip')).toBeNull();
  });

  it('omits the excluded-lakes chip on a recorded zero, not just on absence', () => {
    mockUseQuestContextBreakdown.mockReturnValue({
      data: { ...breakdown, retrieval: { ...breakdown.retrieval, excludedLakes: { count: 0, reason: 'access' } } },
      isLoading: false,
      error: null,
    });
    renderModal();

    expect(screen.queryByTestId('context-breakdown-excluded-lakes-chip')).toBeNull();
  });

  it('surfaces the servers error message when the request was forbidden', () => {
    mockUseQuestContextBreakdown.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: {
        isAxiosError: true,
        response: {
          data: {
            error: 'Context breakdowns are off while your telemetry level is None. Change it in Profile > Settings.',
          },
        },
      },
    });
    renderModal();

    expect(screen.getByTestId('context-breakdown-error').textContent).toBe(
      'Context breakdowns are off while your telemetry level is None. Change it in Profile > Settings.'
    );
  });

  it('surfaces the servers error message when the quest is not found', () => {
    mockUseQuestContextBreakdown.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { isAxiosError: true, response: { data: { error: 'Quest not found' } } },
    });
    renderModal();

    expect(screen.getByTestId('context-breakdown-error').textContent).toBe('Quest not found');
  });

  it('falls back to the generic message when the error carries no server message', () => {
    mockUseQuestContextBreakdown.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Network Error'),
    });
    renderModal();

    expect(screen.getByTestId('context-breakdown-error').textContent).toBe(
      'Could not load the context breakdown for this message.'
    );
  });

  it('reconciles the billed system-prompt total against the layer sum when they differ', () => {
    renderModal();

    const reconciliation = screen.getByTestId('context-breakdown-system-prompt-reconciliation');
    expect(reconciliation.textContent).toContain('2,882');
    expect(reconciliation.textContent).toContain('4,000');
  });

  it('omits the reconciliation line when the billed total matches the layer sum', () => {
    mockUseQuestContextBreakdown.mockReturnValue({
      data: {
        ...breakdown,
        categories: { ...breakdown.categories, systemPromptBilled: breakdown.categories.systemPrompt },
      },
      isLoading: false,
      error: null,
    });
    renderModal();

    expect(screen.queryByTestId('context-breakdown-system-prompt-reconciliation')).toBeNull();
  });

  it('omits the reconciliation line on a turn that recorded no layers', () => {
    mockUseQuestContextBreakdown.mockReturnValue({
      data: { ...breakdown, layers: [], categories: { ...breakdown.categories, systemPrompt: 0 } },
      isLoading: false,
      error: null,
    });
    renderModal();

    expect(screen.queryByTestId('context-breakdown-system-prompt-reconciliation')).toBeNull();
    expect(screen.getByText('This turn recorded no per-layer detail.')).toBeTruthy();
  });
});
