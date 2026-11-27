import type { ApprovalPrompt } from './types';

/*
 * These helpers measure scan confidence as well as mode flags. `unchecked` is diagnostic;
 * actual ChatService tests separately prove that opaque commands wait for consent in Auto and Full.
 */

/** Whether Approve for me runs a shell command as one the scan checked: false when it asks or the scan could not check it. */
export function runsCheckedInAuto(prompt: ApprovalPrompt): boolean {
  return !prompt.askInAuto && !prompt.unchecked;
}

/** Whether Full access runs a shell command as one the scan checked: false when it asks or the scan could not check it. */
export function runsCheckedInFull(prompt: ApprovalPrompt): boolean {
  return !prompt.askInFull && !prompt.unchecked;
}
