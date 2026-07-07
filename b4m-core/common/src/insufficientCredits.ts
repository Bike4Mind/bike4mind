import { UnprocessableEntityError } from './errors';
import { QUEST_ERROR_CODES, QuestErrorCode } from './types';

/**
 * Tags the out-of-credits `UnprocessableEntityError` thrown by the image/video
 * generation credit checks with the machine-readable `insufficient_credits`
 * classifier (the same `QUEST_ERROR_CODES` union the chat reservation path uses).
 *
 * We keep throwing `UnprocessableEntityError` - the credit failure is genuinely a
 * 422 for the HTTP callers - and carry the classifier in `additionalInfo` rather
 * than reclassing to a bespoke error type. Consumers read it back via
 * `getQuestErrorCode` to copy it onto `quest.errorCode`, so the client renders the
 * inline "Add Credits" CTA (InsufficientCreditsNotice) instead of the dead-end raw
 * error text. It also lets the shared tool-batch executor treat this as a terminal
 * failure (mirroring PermissionDeniedError) rather than a recoverable tool
 * observation the model narrates around.
 */
export function insufficientCreditsError(message: string): UnprocessableEntityError {
  return new UnprocessableEntityError(message, { errorCode: 'insufficient_credits' satisfies QuestErrorCode });
}

/**
 * Reads back the `QuestErrorCode` that `insufficientCreditsError` (or any credit
 * check following the same convention) tagged onto a thrown error. Returns
 * `undefined` for untagged errors so callers can leave `quest.errorCode` unset -
 * only genuine, classified failures should drive the targeted error UI.
 */
export function getQuestErrorCode(error: unknown): QuestErrorCode | undefined {
  const code = (error as { additionalInfo?: { errorCode?: unknown } } | null)?.additionalInfo?.errorCode;
  return typeof code === 'string' && (QUEST_ERROR_CODES as readonly string[]).includes(code)
    ? (code as QuestErrorCode)
    : undefined;
}
