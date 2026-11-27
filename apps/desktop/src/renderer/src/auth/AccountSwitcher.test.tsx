// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSelection, BillingAccount } from '@shared/account';
import { useAccountSelection } from '../credits/useAccountSelection';
import { AccountSwitcher } from './AccountSwitcher';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const PERSONAL: BillingAccount = { id: 'u1', name: 'Personal', personal: true, credits: 900 };
const ACME: BillingAccount = { id: 'org-1', name: 'Acme', personal: false, credits: 5000, seats: 4 };

function selectionOf(accounts: BillingAccount[], selected: BillingAccount, dropped: string | null = null) {
  return { accounts, selected, droppedOrganizationId: dropped } satisfies AccountSelection;
}

let root: Root;
let host: HTMLElement;
let pushed: ((selection: AccountSelection) => void) | null = null;
const getSelection = vi.fn<(fresh?: boolean) => Promise<AccountSelection>>();
const selectPayer = vi.fn<(organizationId: string | null) => Promise<AccountSelection>>();

function Harness({ open }: { open: boolean }) {
  return <AccountSwitcher controller={useAccountSelection(open)} />;
}

async function render(open = false) {
  await act(async () =>
    root.render(
      <CssVarsProvider>
        <Harness open={open} />
      </CssVarsProvider>
    )
  );
}

const byTestId = (id: string) => document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  getSelection.mockReset();
  selectPayer.mockReset();
  (window as unknown as { b4m: unknown }).b4m = {
    account: {
      getSelection,
      selectPayer,
      onSelectionChanged: (listener: (selection: AccountSelection) => void) => {
        pushed = listener;
        return () => {
          pushed = null;
        };
      },
    },
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('AccountSwitcher', () => {
  it('lists Personal and each organization with its balance, the payer checked', async () => {
    getSelection.mockResolvedValue(selectionOf([PERSONAL, ACME], PERSONAL));
    await render();

    expect(byTestId('account-switcher-option-personal')?.checked).toBe(true);
    expect(byTestId('account-switcher-option-org-1')?.checked).toBe(false);
    expect(byTestId('account-switcher-option-org-1-balance')?.textContent).toBe((5000).toLocaleString());
    expect(byTestId('account-switcher-option-personal-balance')?.textContent).toBe('900');
  });

  it('picks an organization through main, and back to Personal as null', async () => {
    getSelection.mockResolvedValue(selectionOf([PERSONAL, ACME], PERSONAL));
    selectPayer.mockResolvedValueOnce(selectionOf([PERSONAL, ACME], ACME));
    await render();

    await act(async () => byTestId('account-switcher-option-org-1')?.click());
    expect(selectPayer).toHaveBeenCalledWith('org-1');
    expect(byTestId('account-switcher-option-org-1')?.checked).toBe(true);

    selectPayer.mockResolvedValueOnce(selectionOf([PERSONAL, ACME], PERSONAL));
    await act(async () => byTestId('account-switcher-option-personal')?.click());
    expect(selectPayer).toHaveBeenLastCalledWith(null);
    expect(byTestId('account-switcher-option-personal')?.checked).toBe(true);
  });

  it('hides the list for a user with no organizations', async () => {
    getSelection.mockResolvedValue(selectionOf([PERSONAL], PERSONAL));
    await render();
    expect(byTestId('account-switcher')).not.toBeNull();
    expect(byTestId('account-switcher-option-personal')).toBeNull();
  });

  it('says when the remembered organization fell back to Personal', async () => {
    getSelection.mockResolvedValue(selectionOf([PERSONAL], PERSONAL, 'org-gone'));
    await render();
    expect(byTestId('account-switcher-fallback')?.textContent).toMatch(/Personal pays now/);
  });

  it('shows a refused pick instead of swallowing it', async () => {
    getSelection.mockResolvedValue(selectionOf([PERSONAL, ACME], PERSONAL));
    selectPayer.mockRejectedValue(new Error('That organization is not one of yours, so it cannot pay.'));
    await render();
    await act(async () => byTestId('account-switcher-option-org-1')?.click());
    expect(byTestId('account-switcher-error')?.textContent).toMatch(/not one of yours/);
    expect(byTestId('account-switcher-option-personal')?.checked).toBe(true);
  });

  it('reads fresh when the menu opens, and follows picks from other windows', async () => {
    getSelection.mockResolvedValue(selectionOf([PERSONAL, ACME], PERSONAL));
    await render(false);
    expect(getSelection).toHaveBeenLastCalledWith(false);
    await render(true);
    expect(getSelection).toHaveBeenLastCalledWith(true);

    await act(async () => pushed?.(selectionOf([PERSONAL, ACME], ACME)));
    expect(byTestId('account-switcher-option-org-1')?.checked).toBe(true);
  });
});
