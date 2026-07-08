import { UnprocessableEntityError } from './errors';
import { QUEST_ERROR_CODES, QuestErrorCode } from './types';

/**
 * Out-of-credits 422 tagged with the machine-readable `insufficient_credits` classifier.
 * We keep the 422 HTTP semantics and carry the classifier in `additionalInfo` (rather than
 * reclass to a bespoke error) so `getQuestErrorCode` can copy it onto `quest.errorCode` and
 * the tool-batch executor can treat it as terminal, like PermissionDeniedError.
 */
export function insufficientCreditsError(message: string): UnprocessableEntityError {
  return new UnprocessableEntityError(message, { errorCode: 'insufficient_credits' satisfies QuestErrorCode });
}

/**
 * Reads back the classifier tagged by `insufficientCreditsError`. Returns `undefined` for
 * untagged errors, so only genuine classified failures drive the targeted error UI.
 */
export function getQuestErrorCode(error: unknown): QuestErrorCode | undefined {
  const code = (error as { additionalInfo?: { errorCode?: unknown } } | null)?.additionalInfo?.errorCode;
  return typeof code === 'string' && (QUEST_ERROR_CODES as readonly string[]).includes(code)
    ? (code as QuestErrorCode)
    : undefined;
}
