import type { ApprovalPrompt } from './types';

/*
 * Auto and full mode both run a shell command the scan could not check (`unchecked`). The adversarial tables pin
 * these rather than `askInAuto` or `askInFull`: what they guard is that the scan is never fooled into reading a
 * command that reaches a protected location, or a folder outside the project, as one it checked.
 */

/** Whether Approve for me runs a shell command as one the scan checked: false when it asks or the scan could not check it. */
export function runsCheckedInAuto(prompt: ApprovalPrompt): boolean {
  return !prompt.askInAuto && !prompt.unchecked;
}

/** Whether Full access runs a shell command as one the scan checked: false when it asks or the scan could not check it. */
export function runsCheckedInFull(prompt: ApprovalPrompt): boolean {
  return !prompt.askInFull && !prompt.unchecked;
}
