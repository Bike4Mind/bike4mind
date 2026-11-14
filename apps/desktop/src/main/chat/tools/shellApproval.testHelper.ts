import type { ApprovalPrompt } from './types';

/*
 * These table helpers measure scan confidence as well as mode flags. `unchecked` alone is diagnostic;
 * the real approval gate must also be tested to prove that a risky command waits for consent.
 */

/** Whether Approve for me runs a shell command as one the scan checked: false when it asks or the scan could not check it. */
export function runsCheckedInAuto(prompt: ApprovalPrompt): boolean {
  return !prompt.askInAuto && !prompt.unchecked;
}

/** Whether Full access runs a shell command as one the scan checked: false when it asks or the scan could not check it. */
export function runsCheckedInFull(prompt: ApprovalPrompt): boolean {
  return !prompt.askInFull && !prompt.unchecked;
}
