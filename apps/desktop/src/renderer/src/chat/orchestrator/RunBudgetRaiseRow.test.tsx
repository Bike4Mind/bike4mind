// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RaiseRunBudgetResult } from '@shared/chat';
import { RunBudgetRaiseRow } from './RunBudgetRaiseRow';
import { createThemedMount, el, query } from './testUtils';

const themed = createThemedMount();
const raiseRunBudget = vi.fn<(sessionId: string, budgetCredits: number) => Promise<RaiseRunBudgetResult>>();

beforeEach(() => {
  (window as unknown as { b4m: unknown }).b4m = { chat: { raiseRunBudget } };
});
afterEach(() => {
  themed.unmount();
  raiseRunBudget.mockReset();
});

function type(value: string) {
  const input = el('chat-run-budget-input') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('RunBudgetRaiseRow', () => {
  it('raises the run budget for the session with the credits typed', async () => {
    raiseRunBudget.mockResolvedValue({ ok: true, resumed: 2 });
    await themed.render(<RunBudgetRaiseRow sessionId="s1" />);
    expect((el('chat-run-budget-raise-btn') as HTMLButtonElement).disabled).toBe(true);

    type('1,500');
    await act(async () => el('chat-run-budget-raise-btn').click());

    expect(raiseRunBudget).toHaveBeenCalledWith('s1', 1500);
    expect(query('chat-run-budget-error')).toBeNull();
  });

  it('shows why a raise was refused', async () => {
    raiseRunBudget.mockResolvedValue({ ok: false, error: 'Enter a budget above the current 500 credits.' });
    await themed.render(<RunBudgetRaiseRow sessionId="s1" />);

    type('400');
    await act(async () => el('chat-run-budget-raise-btn').click());

    expect(el('chat-run-budget-error').textContent).toBe('Enter a budget above the current 500 credits.');
  });
});
