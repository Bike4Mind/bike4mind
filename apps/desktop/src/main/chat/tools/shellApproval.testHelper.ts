import type { ApprovalPrompt } from './types';

/** Scan confidence is separate from execution approval: known Git exceptions may still be unchecked. */
export function runsCheckedInFull(prompt: ApprovalPrompt): boolean {
  return !prompt.askInFull && !prompt.unchecked;
}
