import { describe, it, expect } from 'vitest';
import { decideInlineBudgets, COMBINED_INLINE_BUDGET_BYTES, STEPS_INLINE_BUDGET_BYTES } from './reconnectBudget';

const KB = 1024;

describe('decideInlineBudgets (reconnect_result frame budget)', () => {
  it('inlines both when steps + children fit the combined budget', () => {
    const { includeStepsInline, includeChildrenInline } = decideInlineBudgets(60 * KB, 45 * KB);
    expect(includeStepsInline).toBe(true);
    expect(includeChildrenInline).toBe(true);
  });

  it('P1 regression: truncates children when steps+children jointly exceed the cap', () => {
    // 65KB + 65KB = 130KB would assemble a frame past API Gateway's 128KB cap.
    // Each fits its own 100KB budget, but the combined check must drop children.
    const { includeStepsInline, includeChildrenInline } = decideInlineBudgets(65 * KB, 65 * KB);
    expect(includeStepsInline).toBe(true); // steps take priority
    expect(includeChildrenInline).toBe(false); // children fall back to REST
  });

  it('children get the FULL combined budget when steps are truncated to REST', () => {
    // Steps over their own 100KB budget -> not inline -> children may use up to
    // the full combined budget since steps no longer occupy the frame.
    const { includeStepsInline, includeChildrenInline } = decideInlineBudgets(105 * KB, 105 * KB);
    expect(includeStepsInline).toBe(false);
    expect(includeChildrenInline).toBe(true);
  });

  it('inlines children exactly at the remaining budget boundary', () => {
    const stepsSize = 60 * KB;
    const exactlyRemaining = COMBINED_INLINE_BUDGET_BYTES - stepsSize; // 50KB
    expect(decideInlineBudgets(stepsSize, exactlyRemaining).includeChildrenInline).toBe(true);
    expect(decideInlineBudgets(stepsSize, exactlyRemaining + 1).includeChildrenInline).toBe(false);
  });

  it('never inlines children when there are none (size 0)', () => {
    expect(decideInlineBudgets(10 * KB, 0).includeChildrenInline).toBe(false);
  });

  it('inlines steps exactly at their own budget boundary', () => {
    expect(decideInlineBudgets(STEPS_INLINE_BUDGET_BYTES, 0).includeStepsInline).toBe(true);
    expect(decideInlineBudgets(STEPS_INLINE_BUDGET_BYTES + 1, 0).includeStepsInline).toBe(false);
  });
});
