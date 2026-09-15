import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { MissionCard } from './MissionsSection';
import type { AgentRosterItem } from '@client/app/hooks/data/deepAgents';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const mission: AgentRosterItem = {
  agentId: 'mission-1',
  name: 'Coffee',
  role: 'default',
  goal: 'Draft one short piece of marketing copy each wake.',
  currentTier: 'engineering-proxy',
  version: 3,
  semanticMemoryCount: 2,
  blockers: ['waiting on brand guidelines'],
  updatedAt: '2026-06-12T00:00:00.000Z',
  wakeCount: 3,
  nextIntendedAction: 'Try the sovereignty angle next.',
};

describe('MissionCard', () => {
  it('renders goal, tier, wake/memory/version stats, blockers, and next action', () => {
    render(
      <TestWrapper>
        <MissionCard mission={mission} onOpen={() => {}} />
      </TestWrapper>
    );
    expect(screen.getByText('Draft one short piece of marketing copy each wake.')).toBeTruthy();
    expect(screen.getByText('engineering-proxy')).toBeTruthy();
    expect(screen.getByText('3 wakes')).toBeTruthy();
    expect(screen.getByText('2 memories')).toBeTruthy();
    expect(screen.getByText('v3')).toBeTruthy();
    expect(screen.getByText('1 blocker')).toBeTruthy();
    expect(screen.getByText(/Try the sovereignty angle next/)).toBeTruthy();
  });

  it('opens the dossier on click', () => {
    const onOpen = vi.fn();
    render(
      <TestWrapper>
        <MissionCard mission={mission} onOpen={onOpen} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('mission-card'));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
