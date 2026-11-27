import { HTTPError, SAFE_ERROR_CODE } from '@bike4mind/common';
import { getHttpStatus } from '@bike4mind/utils';
import { resolveQuestErrorCode } from '@bike4mind/services/llm';

/**
 * Names a failure without its message: provider, validation and tool-argument errors can quote the
 * prompt, and this event is stored. A code that is not a short identifier is dropped.
 */
export function completionFailureCode(error: unknown): { errorCode: string; status?: number } {
  const status =
    error instanceof HTTPError ? error.statusCode : error instanceof Error ? getHttpStatus(error) : undefined;
  const code = (error as { additionalInfo?: { errorCode?: unknown } } | null)?.additionalInfo?.errorCode;
  const errorCode =
    resolveQuestErrorCode(error) ??
    (typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : status ? `http_${status}` : 'unknown');
  return { errorCode, ...(status ? { status } : {}) };
}
