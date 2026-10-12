import { DecisionResponseMismatchError, type DecisionsErrorCode } from '@bike4mind/common';
import { DecisionOverloadedError, DecisionProviderError } from '@bike4mind/utils/decisionProviders';
import type { Response } from 'express';
import { DecisionImageError } from './resolveDecisionInput';

type DecisionErrorReply = { status: number; error: string; errorCode?: DecisionsErrorCode; param?: string };

/** Maps a decision-call failure onto the public envelope, or null for an unexpected error the route rethrows. */
export const toDecisionErrorReply = (error: unknown): DecisionErrorReply | null => {
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
