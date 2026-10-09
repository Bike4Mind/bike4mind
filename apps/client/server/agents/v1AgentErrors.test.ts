import { describe, expect, it } from 'vitest';
import { AGENT_LIMIT_REACHED_ERROR_CODE } from '@bike4mind/common';
import { AgentValidationError } from '@server/utils/agentValidation';
import { BadRequestError, NotFoundError, UnprocessableEntityError } from '@server/utils/errors';
import { toV1AgentError } from './v1AgentErrors';

describe('toV1AgentError', () => {
  it('remaps a field validation error to a 422 with its message', () => {
    const mapped = toV1AgentError(new AgentValidationError('Invalid model: x'));
    expect(mapped).toBeInstanceOf(UnprocessableEntityError);
    expect(mapped).toMatchObject({ statusCode: 422, message: 'Invalid model: x' });
  });

  it.each([
    ['the tier cap', new BadRequestError('cap', { errorCode: AGENT_LIMIT_REACHED_ERROR_CODE })],
    ['any other 400', new BadRequestError('User not found')],
    ['a non-400 HTTP error', new NotFoundError('gone')],
    ['a plain error', new Error('boom')],
  ])('passes %s through unchanged', (_label, error) => {
    expect(toV1AgentError(error)).toBe(error);
  });
});
