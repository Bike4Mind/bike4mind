/**
 * Curated starter task list. Add tasks here as they're authored.
 *
 * Each task should exercise a distinct agent capability (single-tool,
 * multi-tool chaining, exact-output production, code understanding, etc.)
 * Avoid duplicating coverage - the eval suite's value scales with
 * breadth, not depth.
 */
import type { EvalTask } from '../types.js';
import { readFileTask } from './readFile.task.js';
import { createFileTask } from './createFile.task.js';
import { multiStepEditTask } from './multiStepEdit.task.js';
import { findAndFixBugTask } from './findAndFixBug.task.js';
import { multiFileRefactorTask } from './multiFileRefactor.task.js';
import { codeUnderstandingTask } from './codeUnderstanding.task.js';

/**
 * Curated suite of 6 tasks chosen for behavioral coverage:
 *  1. read-file: single-tool, exact-recall
 *  2. create-file: tool-side-effect, exact-output
 *  3. multi-step-edit: 2-tool chain, surgical edit
 *  4. find-and-fix-bug: ambiguous spec, requires reasoning
 *  5. multi-file-refactor: cross-file, grep + multi-edit
 *  6. code-understanding: read + reason, no mutation (and must NOT mutate)
 */
export const STARTER_TASKS: readonly EvalTask[] = [
  readFileTask,
  createFileTask,
  multiStepEditTask,
  findAndFixBugTask,
  multiFileRefactorTask,
  codeUnderstandingTask,
];
