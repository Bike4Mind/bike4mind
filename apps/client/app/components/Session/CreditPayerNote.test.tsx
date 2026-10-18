import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ISessionDocument } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  enforceCredits: true,
  projects: [] as { userId: string; sessionIds: string[] }[],
  account: null as { id: string; name: string; personal: boolean } | null,
  organizationId: null as string | null,
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
vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (s: { organizationId: string | null }) => unknown) =>
    selector({ organizationId: h.organizationId }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: { currentUser: { id: string } }) => unknown) => selector({ currentUser: { id: 'me' } }),
}));

import { useCreditPayerNote, payerNoteText } from './CreditPayerNote';

const session = (userId: string) => ({ id: 's1', userId }) as ISessionDocument;

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

describe('useCreditPayerNote', () => {
  beforeEach(() => {
    h.enforceCredits = true;
    h.projects = [];
    h.account = null;
    h.organizationId = null;
  });

  const noteFor = (s: ISessionDocument) => renderHook(() => useCreditPayerNote(s)).result.current;

  it('names the user as payer in a shared notebook', () => {
    expect(noteFor(session('owner'))).toBe("Paid from your balance, not the owner's");
  });

  it('says nothing while credits are not enforced', () => {
    h.enforceCredits = false;
    expect(noteFor(session('owner'))).toBeNull();
  });

  it('names the organization the send bills', () => {
    h.account = { id: 'org-1', name: 'Acme', personal: false };
    h.organizationId = 'org-1';
    expect(noteFor(session('owner'))).toBe("Paid from Acme credits, not the owner's");
  });

  it('names the user when the menu shows a team but the send carries no organization', () => {
    h.account = { id: 'org-1', name: 'Acme', personal: false };
    expect(noteFor(session('owner'))).toBe("Paid from your balance, not the owner's");
  });
});
