/**
 * Tests: code reading + reasoning, no mutation required.
 *
 * The agent reads a small function and must answer a behavioral
 * question about it ("what does it return for input X"). This
 * specifically excludes file modification - the agent must not
 * "fix" the code, just understand it. A good signal for whether
 * the agent over-acts on prompts.
 *
 * The function deliberately has a non-obvious behavior (returns 0
 * for any negative input) so the answer requires actual reading,
 * not pattern matching the question.
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { EvalTask } from '../types.js';

const FUNCTION_CODE = `// Returns the discount in cents for a given subtotal in cents.
// Negative or zero subtotals get no discount.
export function discount(subtotalCents: number): number {
  if (subtotalCents <= 0) return 0;
  if (subtotalCents < 1000) return 0;
  if (subtotalCents < 5000) return Math.floor(subtotalCents * 0.05);
  return Math.floor(subtotalCents * 0.10);
}
`;

export const codeUnderstandingTask: EvalTask = {
  id: 'code-understanding',
  description: 'Reads a function and reasons about its behavior for a specific input without modifying it',
  prompt: sandboxDir =>
    `Read ${sandboxDir}/discount.ts. What value would discount(-50) return? Give just the numeric answer in your response.`,
  setup: async sandboxDir => {
    await fs.writeFile(path.join(sandboxDir, 'discount.ts'), FUNCTION_CODE, 'utf-8');
  },
  check: async (result, sandboxDir) => {
    // The correct answer is 0 (the negative-subtotal early return).
    // We accept "0" as a token in the answer; reject if the agent
    // modified the file (it shouldn't have).
    const target = path.join(sandboxDir, 'discount.ts');
    const fileUnchanged = (await fs.readFile(target, 'utf-8')) === FUNCTION_CODE;
    if (!fileUnchanged) {
      return { passed: false, reason: 'agent modified the file when only reading was required' };
    }

    // Match "0" as a standalone token in the final answer (not inside
    // a larger number like "1000"). Tolerant of phrasing.
    const hasZero = /\b0\b/.test(result.finalAnswer);
    if (!hasZero) {
      return {
        passed: false,
        reason: `final answer does not contain "0" (got: ${result.finalAnswer.slice(0, 100)}...)`,
      };
    }
    return { passed: true, reason: 'correctly answered 0 without modifying the file' };
  },
};
