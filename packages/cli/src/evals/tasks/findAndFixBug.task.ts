/**
 * Tests: ambiguity tolerance + reasoning + targeted edit.
 *
 * Unlike the precise-instruction tasks, this one says only "there's a
 * bug somewhere" - the agent must read the code, find the bug, and
 * fix it without being told what to look for. This is the closest
 * task we have to a real B4M user request, and the one most likely
 * to differentiate "minimal prompt" from "scaffolded prompt": if the
 * scaffolding's "be proactive / make assumptions" guidance matters
 * anywhere, it should matter here.
 *
 * The seeded bug is an off-by-one error in a slice() call that
 * causes the function to drop the first element of every result.
 * Subtle enough to require actually reading and reasoning, but
 * unambiguous once located.
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { EvalTask } from '../types.js';

const BUGGY_CODE = `// Returns the first N items from the array.
// Bug: drops the first element because of a slice off-by-one.
export function takeFirst<T>(items: T[], n: number): T[] {
  if (n <= 0) return [];
  return items.slice(1, n + 1);
}
`;

const FIXED_CODE = `// Returns the first N items from the array.
// Bug: drops the first element because of a slice off-by-one.
export function takeFirst<T>(items: T[], n: number): T[] {
  if (n <= 0) return [];
  return items.slice(0, n);
}
`;

export const findAndFixBugTask: EvalTask = {
  id: 'find-and-fix-bug',
  description: 'Locates a subtle bug in a file and fixes it without being told what to look for',
  prompt: sandboxDir =>
    `There is a bug in ${sandboxDir}/takeFirst.ts. The function is supposed to return the first N elements but it's returning something wrong. Read the file, find the bug, and fix it.`,
  setup: async sandboxDir => {
    await fs.writeFile(path.join(sandboxDir, 'takeFirst.ts'), BUGGY_CODE, 'utf-8');
  },
  check: async (_result, sandboxDir) => {
    const target = path.join(sandboxDir, 'takeFirst.ts');
    try {
      const actual = await fs.readFile(target, 'utf-8');
      if (actual === FIXED_CODE) {
        return { passed: true, reason: 'bug fixed correctly with surrounding code preserved' };
      }
      // Behavioral check: did the slice get fixed even if surrounding text changed?
      const sliceMatch = actual.match(/\.slice\(\s*0\s*,\s*n\s*\)/);
      if (sliceMatch) {
        return {
          passed: true,
          reason: 'slice fixed (0, n) — surrounding code modified but the behavior is correct',
        };
      }
      return {
        passed: false,
        reason: 'bug not fixed (slice still incorrect)',
      };
    } catch (error) {
      return {
        passed: false,
        reason: `file unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
