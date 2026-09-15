/**
 * Tests: cross-file reasoning + grep/glob + multi-edit chaining.
 *
 * A function is renamed but its callers in two other files still use
 * the old name. The agent must locate every call site (via search,
 * not by being told) and update each one. Exercises the agent's
 * willingness to use search tools and chain edits across files.
 *
 * Failure modes this catches:
 *  - Agent only edits the file mentioned in the prompt and stops
 *  - Agent uses grep but misses one of the call sites
 *  - Agent edits the function definition but breaks one of the imports
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { EvalTask } from '../types.js';

const ORIGINAL_LIB = `export function calculateTotal(items: number[]): number {
  return items.reduce((a, b) => a + b, 0);
}
`;

const ORIGINAL_USER_A = `import { calculateTotal } from './lib';

export function reportA(items: number[]): string {
  return \`Total A: \${calculateTotal(items)}\`;
}
`;

const ORIGINAL_USER_B = `import { calculateTotal } from './lib';

export function reportB(items: number[]): string {
  return \`Total B: \${calculateTotal(items.map(x => x * 2))}\`;
}
`;

export const multiFileRefactorTask: EvalTask = {
  id: 'multi-file-refactor',
  description: 'Renames a function and updates all call sites across multiple files',
  prompt: sandboxDir =>
    `In ${sandboxDir}, rename the function "calculateTotal" to "sumAll". The function is defined in lib.ts and called from other files. Update every call site so the code still works.`,
  setup: async sandboxDir => {
    await fs.writeFile(path.join(sandboxDir, 'lib.ts'), ORIGINAL_LIB, 'utf-8');
    await fs.writeFile(path.join(sandboxDir, 'userA.ts'), ORIGINAL_USER_A, 'utf-8');
    await fs.writeFile(path.join(sandboxDir, 'userB.ts'), ORIGINAL_USER_B, 'utf-8');
  },
  check: async (_result, sandboxDir) => {
    try {
      const lib = await fs.readFile(path.join(sandboxDir, 'lib.ts'), 'utf-8');
      const userA = await fs.readFile(path.join(sandboxDir, 'userA.ts'), 'utf-8');
      const userB = await fs.readFile(path.join(sandboxDir, 'userB.ts'), 'utf-8');

      // Old name should be gone everywhere
      const oldStillPresent = [lib, userA, userB].filter(c => c.includes('calculateTotal'));
      if (oldStillPresent.length > 0) {
        return {
          passed: false,
          reason: `"calculateTotal" still present in ${oldStillPresent.length} file(s)`,
        };
      }

      // New name should be present in all three (definition + 2 call sites)
      const hasNewName = [lib, userA, userB].every(c => c.includes('sumAll'));
      if (!hasNewName) {
        return {
          passed: false,
          reason: '"sumAll" missing from at least one file',
        };
      }

      return { passed: true, reason: 'rename applied across lib.ts, userA.ts, userB.ts' };
    } catch (error) {
      return {
        passed: false,
        reason: `file unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
  // Refactors typically need a few more iterations than single-file tasks.
  maxIterations: 25,
};
