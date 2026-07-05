/**
 * Tests: create_file tool, exact-content production.
 *
 * The agent must write a specific file with specific contents - no
 * paraphrasing, no extra characters. This is a stricter check than
 * read-file because we verify on disk, not in the answer text.
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { EvalTask } from '../types.js';

const TARGET_CONTENT = 'hello from b4m eval suite';

export const createFileTask: EvalTask = {
  id: 'create-file',
  description: 'Creates a file at a specified path with specified exact contents',
  prompt: sandboxDir =>
    `Create a file at ${sandboxDir}/output.txt containing exactly this text and nothing else: "${TARGET_CONTENT}"`,
  check: async (_result, sandboxDir) => {
    const target = path.join(sandboxDir, 'output.txt');
    try {
      const actual = await fs.readFile(target, 'utf-8');
      if (actual.trim() === TARGET_CONTENT) {
        return { passed: true, reason: 'file written with exact target content' };
      }
      return {
        passed: false,
        reason: `file content mismatch (expected "${TARGET_CONTENT}", got "${actual.slice(0, 60)}...")`,
      };
    } catch (error) {
      return {
        passed: false,
        reason: `file not created: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
