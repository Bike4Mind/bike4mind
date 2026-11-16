import { DecisionResponseMismatchError, type DecisionsErrorCode } from '@bike4mind/common';
import { DecisionOverloadedError, DecisionProviderError } from '@bike4mind/utils/decisionProviders';
import type { Response } from 'express';
import { DecisionImageError } from './resolveDecisionInput';

type DecisionErrorReply = { status: number; error: string; errorCode?: DecisionsErrorCode; param?: string };

/**
 * A decision failure whose status and public error code are decided where it is thrown - the
 * model/provider/validation gates that live in `runDecision`, away from the HTTP response. Mapped
 * here first so those gates keep the statuses and codes the route returned inline.
 */
export class DecisionRequestError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: DecisionsErrorCode,
    readonly param: string | undefined,
    message: string
  ) {
    super(message);
    this.name = 'DecisionRequestError';
  }
}

/** Maps a decision-call failure onto the public envelope, or null for an unexpected error the route rethrows. */
export const toDecisionErrorReply = (error: unknown): DecisionErrorReply | null => {
  if (error instanceof DecisionRequestError) {
    // Omit `param` rather than send it as null/'' - the route never serialized one for these.
    return {
      status: error.status,
      error: error.message,
      errorCode: error.errorCode,
      ...(error.param === undefined ? {} : { param: error.param }),
    };
  }
  if (error instanceof DecisionImageError) {
    return { status: error.status, error: error.message, errorCode: error.errorCode, param: error.param };
  }
  if (error instanceof DecisionOverloadedError) {
    return {
      status: 503,
      error: 'The decision provider is overloaded; retry later.',
      errorCode: 'provider_overloaded',
    };
  }
  if (error instanceof DecisionResponseMismatchError) {
    return {
      status: 502,
      error: 'The decision provider returned an answer that does not fit the questions.',
      errorCode: 'provider_error',
    };
  }
  if (!(error instanceof DecisionProviderError)) return null;
  const param = error.details.param;
  switch (error.kind) {
    case 'rejected_key':
      return {
        status: 401,
        error: 'The decision provider rejected the configured credential.',
        errorCode: 'provider_rejected',
      };
    case 'context_length':
      return { status: 422, error: error.message, errorCode: 'context_length_exceeded', param };
    case 'invalid_request':
      return { status: 422, error: error.message, errorCode: 'invalid_request', param };
    case 'overloaded':
      return {
        status: 503,
        error: 'The decision provider is overloaded; retry later.',
        errorCode: 'provider_overloaded',
      };
    case 'upstream':
      return { status: 502, error: 'The decision provider failed.', errorCode: 'provider_error' };
  }
};

/**
 * A failure's class, with no message, for a host that persists it: the CLI tool path writes whatever
 * its executor throws into `toolExecutionLog`, and a provider message can quote the caller's input.
 * Same discipline as the runner's own `describeFailure`, extended to the pre-provider gates.
 */
export const describeDecisionFailure = (error: unknown): string => {
  if (error instanceof DecisionRequestError) return `decision_request_error: ${error.errorCode}`;
  if (error instanceof DecisionImageError) return `decision_input_error: ${error.errorCode}`;
  if (error instanceof DecisionResponseMismatchError) return 'provider_error: response_mismatch';
  const providerError = error instanceof DecisionOverloadedError ? error.providerError : error;
  if (providerError instanceof DecisionProviderError) return `provider_error: ${providerError.kind}`;
  return error instanceof Error ? error.name : 'unknown_error';
};

/** Writes the reply; returns false for an unexpected error so the caller rethrows it to errorHandler. */
export const sendDecisionError = (res: Response, error: unknown): boolean => {
  const reply = toDecisionErrorReply(error);
  if (!reply) return false;
  if (reply.errorCode === 'provider_overloaded') {
    const seconds = error instanceof DecisionOverloadedError ? error.retryAfterSeconds : 1;
    res.setHeader('Retry-After', String(seconds));
  }
  const { status, ...body } = reply;
  res.status(status).json(body);
  return true;
};
