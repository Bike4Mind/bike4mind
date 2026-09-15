/**
 * Tests: file_read -> edit_local_file chain, targeted single-line fix.
 *
 * The classic "fix this typo" task - exercises the agent's ability to
 * locate a specific string in a file and replace it without disturbing
 * surrounding content. A common real-world B4M task.
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { EvalTask } from '../types.js';

const ORIGINAL = `function processOrder(order) {
  // recieve the order from the queue
  return order;
}
`;

const EXPECTED = `function processOrder(order) {
  // receive the order from the queue
  return order;
}
`;

export const multiStepEditTask: EvalTask = {
  id: 'multi-step-edit',
  description: 'Reads a file, locates a typo, and fixes it via a targeted edit',
  prompt: sandboxDir =>
    `In the file ${sandboxDir}/order.ts there is a typo: "recieve" should be "receive". Fix it without changing anything else in the file.`,
  setup: async sandboxDir => {
    await fs.writeFile(path.join(sandboxDir, 'order.ts'), ORIGINAL, 'utf-8');
  },
  check: async (_result, sandboxDir) => {
    const target = path.join(sandboxDir, 'order.ts');
    try {
      const actual = await fs.readFile(target, 'utf-8');
      if (actual === EXPECTED) {
        return { passed: true, reason: 'typo fixed, surrounding content preserved' };
      }
      if (actual.includes('recieve')) {
        return { passed: false, reason: 'typo "recieve" still present' };
      }
      return {
        passed: false,
        reason: 'typo removed but surrounding content was modified',
      };
    } catch (error) {
      return {
        passed: false,
        reason: `file unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
