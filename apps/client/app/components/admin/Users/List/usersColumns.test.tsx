import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { AdminUsersListRow } from '@client/app/utils/adminUsersFilter';
import { getThemeConfig } from '@client/app/utils/themes';
import { signupVerdictDisplay, usersColumns } from './usersColumns';

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;

describe('signupVerdictDisplay', () => {
  it('warns on a suspected account and names every signal', () => {
    expect(signupVerdictDisplay({ suspected: true, signals: ['signupSpike', 'aliasedEmail'] }, '7d')).toEqual({
      label: 'Suspected',
      tone: 'warn',
      title: 'Signup chart, last 7 days: Signup spike, Aliased address.',
    });
  });

  it('keeps a likely-legit account neutral and still shows a lone weak signal', () => {
    expect(signupVerdictDisplay({ suspected: false, signals: ['datacenterNetwork'] }, '24h')).toMatchObject({
      label: 'Likely legit',
      tone: 'neutral',
      title: 'Signup chart, last 24 hours: one weak signal, Datacenter network.',
    });
    expect(signupVerdictDisplay({ suspected: false, signals: [] }, '24h')?.title).toBe(
      'Signup chart, last 24 hours: no suspected-signup signals.'
    );
  });

  it('shows nothing for an account the chart did not classify, or before verdicts load', () => {
    expect(signupVerdictDisplay(null, '7d')).toBeUndefined();
    expect(signupVerdictDisplay(undefined, '7d')).toBeUndefined();
  });
});

describe('Verdict column', () => {
  const row = { id: 'u1' } as AdminUsersListRow;
  const renderVerdict = (verdicts?: Parameters<typeof usersColumns>[0]['verdict']['verdicts']) => {
    const column = usersColumns({ now: new Date(), maxSpend: 0, verdict: { range: '7d', verdicts } }).find(
      candidate => candidate.id === 'verdict'
    );
    render(<>{column?.render(row)}</>, { wrapper: Wrapper });
  };

  it('renders the verdict chip with its reasons on hover', () => {
    renderVerdict({ u1: { suspected: true, signals: ['wafBotSignal'] } });
    const chip = screen.getByTestId('admin-users-verdict-u1');
    expect(chip.textContent).toBe('Suspected');
    expect(chip.closest('[title]')?.getAttribute('title')).toBe('Signup chart, last 7 days: Bot traffic.');
  });

  it('falls back to a dash while loading or after a failed fetch', () => {
    renderVerdict(undefined);
    expect(screen.queryByTestId('admin-users-verdict-u1')).toBeNull();
    expect(screen.getByLabelText('None')).toBeTruthy();
  });
});
