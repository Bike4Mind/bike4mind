/**
 * Tests: file_read tool, multi-tool reasoning skipped, single-shot answer.
 *
 * The agent must use file_read to discover content it could not have
 * known otherwise, then incorporate it into the final answer.
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { EvalTask } from '../types.js';

const SECRET_TOKEN = 'pi-coding-agent-was-here-9472';

export const readFileTask: EvalTask = {
  id: 'read-file',
  description: 'Reads a single file and incorporates its content into the answer',
  prompt: sandboxDir => `Read the file at ${sandboxDir}/secret.txt and tell me the exact contents. Do not paraphrase.`,
  setup: async sandboxDir => {
    await fs.writeFile(path.join(sandboxDir, 'secret.txt'), SECRET_TOKEN, 'utf-8');
  },
  check: async result => {
    const passed = result.finalAnswer.includes(SECRET_TOKEN);
    return {
      passed,
      reason: passed
        ? 'final answer contains the secret token'
        : `final answer missing the secret token (got: ${result.finalAnswer.slice(0, 100)}...)`,
    };
  },
};
