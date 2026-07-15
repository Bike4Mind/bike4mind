import type { IImageTemplateCaller } from '@bike4mind/common';
import { ForbiddenError, UnauthorizedError } from '@bike4mind/common';

/**
 * Access contract for image templates. Every template is personal (userId-owned)
 * - there are no shared/system templates in M1 - so the rules are simpler than
 * the briefcase's: authenticated interactive users only.
 */

/** Rejects an unauthenticated caller. */
export function assertAuthenticated(caller: IImageTemplateCaller | undefined): asserts caller is IImageTemplateCaller {
  if (!caller?.id) {
    throw new UnauthorizedError('Authentication required for image templates');
  }
}

/**
 * Rejects an API-key caller from personal operations. An API key is a headless
 * integration, not the owning human; letting any key holder read/mutate the
 * key-user's personal templates is a confused-deputy path (same defense as the
 * briefcase's personal-prompt gate).
 */
export function assertInteractive(caller: IImageTemplateCaller): void {
  if (caller.isApiKey) {
    throw new ForbiddenError('API keys cannot access personal image templates');
  }
}
