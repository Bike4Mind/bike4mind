import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ISessionDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  enforceCredits: true,
  projects: [] as { userId: string; sessionIds: string[] }[],
  account: null as { name: string; personal: boolean } | null,
}));

vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'enforceCredits' ? h.enforceCredits : undefined),
}));
vi.mock('@client/app/hooks/data/projects', () => ({
  useGetJoinedProjects: () => ({ data: h.projects }),
}));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: () => ({ selectedAccount: h.account }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: { currentUser: { id: string } }) => unknown) => selector({ currentUser: { id: 'me' } }),
}));

import { CreditPayerNote, payerNoteText } from './CreditPayerNote';

const appTheme = extendTheme({ ...getThemeConfig() });
const session = (userId: string) => ({ id: 's1', userId }) as ISessionDocument;
const renderNote = (s: ISessionDocument) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <CreditPayerNote session={s} />
    </CssVarsProvider>
  );

describe('payerNoteText', () => {
  it('says nothing in a notebook the user owns outside any shared project', () => {
    expect(payerNoteText({ currentUserId: 'me', session: session('me'), projects: [], account: null })).toBeNull();
  });

  it('names the user as payer in a notebook someone else owns', () => {
    expect(payerNoteText({ currentUserId: 'me', session: session('owner'), projects: [], account: null })).toBe(
      "Paid from your balance, not the owner's"
    );
  });

  it('names the user as payer in their own notebook inside a project someone else owns', () => {
    const projects = [{ userId: 'owner', sessionIds: ['s1'] }];
    expect(payerNoteText({ currentUserId: 'me', session: session('me'), projects, account: null })).toBe(
      "Paid from your balance, not the owner's"
    );
  });

  it('ignores a project the user owns', () => {
    const projects = [{ userId: 'me', sessionIds: ['s1'] }];
    expect(payerNoteText({ currentUserId: 'me', session: session('me'), projects, account: null })).toBeNull();
  });

  it('names the organization pool when a team account is the payer', () => {
    const account = { name: 'Acme', personal: false };
    expect(payerNoteText({ currentUserId: 'me', session: session('owner'), projects: [], account })).toBe(
      "Paid from Acme credits, not the owner's"
    );
  });
});

describe('CreditPayerNote', () => {
  beforeEach(() => {
    h.enforceCredits = true;
    h.projects = [];
    h.account = null;
  });

  it('renders the payer line in a shared notebook', () => {
    renderNote(session('owner'));
    expect(screen.getByTestId('session-credit-payer-note')).toHaveTextContent(
      "Paid from your balance, not the owner's"
    );
  });

  it('renders nothing while credits are not enforced', () => {
    h.enforceCredits = false;
    renderNote(session('owner'));
    expect(screen.queryByTestId('session-credit-payer-note')).not.toBeInTheDocument();
  });
});
