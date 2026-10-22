import type { PrBinding, PrState } from '@shared/pullRequest';

/**
 * Whether this read is the moment to archive: auto-archive is on, the PR was last seen OPEN and
 * is now merged or closed, and it has not fired before.
 *
 * Measured from a state actually SEEN open, so binding a PR that is already merged archives
 * nothing, and `archivedOnClose` makes it once-only: a user who unarchives the conversation
 * afterwards keeps it.
 */
export function shouldAutoArchive(binding: PrBinding, next: PrState): boolean {
  return (
    binding.autoArchive === true &&
    binding.archivedOnClose !== true &&
    binding.lastState === 'OPEN' &&
    (next === 'MERGED' || next === 'CLOSED')
  );
}
