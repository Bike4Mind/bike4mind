import { describe, expect, it, vi } from 'vitest';
import { withinTriageBudget } from './dlqTriageBudget';

describe('DLQ triage budget', () => {
  it('does not start work after the deadline', async () => {
    const work = vi.fn();
    await expect(withinTriageBudget(Date.now() - 1, work)).rejects.toThrow('deadline');
    expect(work).not.toHaveBeenCalled();
  });
  it('bounds a stalled operation', async () => {
    await expect(withinTriageBudget(Date.now() + 10, () => new Promise(() => {}))).rejects.toThrow('deadline');
  });
  it('returns completed work', async () => {
    await expect(withinTriageBudget(Date.now() + 1_000, async () => 'done')).resolves.toBe('done');
  });
});
