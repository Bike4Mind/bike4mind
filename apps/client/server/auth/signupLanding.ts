import type { Logger } from '@bike4mind/observability';
import { sessionRepository, userRepository } from '@bike4mind/database';

// The SPA route `/notebooks/$id` (apps/client/app/router.tsx); the id is a Session id.
const NOTEBOOK_PATH = /^\/notebooks\/([a-f0-9]{24})(?:[/?#]|$)/i;

/** The notebook id a post-login redirect names, or null for any other target. */
export function notebookIdOfRedirect(redirectTo: string | undefined): string | null {
  if (!redirectTo) return null;
  let pathname: string;
  try {
    // Relative targets are the norm; the base only lets URL parse them.
    pathname = new URL(redirectTo, 'https://redirect.invalid').pathname;
  } catch {
    return null;
  }
  return NOTEBOOK_PATH.exec(pathname)?.[1]?.toLowerCase() ?? null;
}

/**
 * Records, on a new OAuth account, the owner of the notebook its post-login redirect named when that
 * owner is another account. Abuse evidence for automated containment (an account farm hands every
 * new account the same notebook link). Never throws: the signup has already happened.
 */
export async function recordSignupLanding(
  input: { userId: string; redirectTo: string | undefined; now?: Date },
  logger?: Pick<Logger, 'warn'>
): Promise<void> {
  const notebookId = notebookIdOfRedirect(input.redirectTo);
  if (!notebookId) return;
  try {
    const notebook = await sessionRepository.findById(notebookId);
    const ownerId = notebook?.userId ? String(notebook.userId) : null;
    if (!ownerId || ownerId === input.userId) return;
    await userRepository.recordSignupLanding(input.userId, ownerId, input.now ?? new Date());
  } catch (error) {
    (logger ?? console).warn('Signup landing was not recorded', {
      userId: input.userId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
