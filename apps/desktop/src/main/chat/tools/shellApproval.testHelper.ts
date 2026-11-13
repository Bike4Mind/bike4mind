import { UNREAD_WSL_COMMAND } from './shellTools';
import type { ApprovalPrompt } from './types';

/** The card reasons shellApproval gives for a command the scan could not check (see partAsk and unreadApproval). */
const UNCHECKED_REASONS = ['Desktop cannot follow', 'Desktop does not list as safe'];

/**
 * Whether Full access runs a shell command as one the scan checked. False when Full access asks, and when it runs
 * the command only because the scan cannot follow it or does not list its git form, which auto mode asks about.
 * The adversarial tables pin this rather than `askInFull`: what they guard is that the scan is never fooled into
 * reading a command that reaches a protected location as safe.
 */
export function runsCheckedInFull(prompt: ApprovalPrompt): boolean {
  if (prompt.askInFull) return false;
  const unchecked =
    !prompt.always ||
    prompt.always.ungranted?.includes(UNREAD_WSL_COMMAND) === true ||
    UNCHECKED_REASONS.some(reason => prompt.detail.includes(reason));
  return !unchecked;
}
