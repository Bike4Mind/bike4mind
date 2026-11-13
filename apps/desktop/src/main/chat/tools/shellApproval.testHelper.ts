import type { ApprovalPrompt } from './types';

/**
 * Whether Full access runs a shell command as one the scan checked. False when Full access asks, and when it runs
 * the command only because the scan cannot follow it or does not list its git form (`unchecked`), which auto mode
 * asks about. The adversarial tables pin this rather than `askInFull`: what they guard is that the scan is never
 * fooled into reading a command that reaches a protected location as safe.
 */
export function runsCheckedInFull(prompt: ApprovalPrompt): boolean {
  return !prompt.askInFull && !prompt.unchecked;
}
