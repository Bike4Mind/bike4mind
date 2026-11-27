// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { AccountSelection, BillingAccount } from '@shared/account';
import { GenerationPayerNote } from './GenerationPayerNote';
import { payerLabel } from './payer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function noteFor(selected: BillingAccount | null): Promise<string | null> {
  const selection: AccountSelection = { accounts: selected ? [selected] : [], selected, droppedOrganizationId: null };
  (window as unknown as { b4m: unknown }).b4m = {
    account: { getSelection: async () => selection, onSelectionChanged: () => () => {} },
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(<GenerationPayerNote data-testid="payer-note" />));
  const text = host.querySelector('[data-testid="payer-note"]')?.textContent ?? null;
  act(() => root.unmount());
  return text;
}

describe('GenerationPayerNote', () => {
  it('uses the web wording for each payer', async () => {
    expect(await noteFor({ id: 'u1', name: 'Personal', personal: true, credits: 1 })).toBe(
      'Paid from your personal credits'
    );
    expect(await noteFor({ id: 'org-1', name: 'Acme', personal: false, credits: 1 })).toBe('Paid from Acme credits');
    expect(await noteFor(null)).toBeNull();
  });

  it('names no payer without an account', () => {
    expect(payerLabel(null)).toBeNull();
  });
});
