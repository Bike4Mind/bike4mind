import { describe, expect, it } from 'vitest';
import { AGENT_LIMIT_REACHED_ERROR_CODE } from '@bike4mind/common';
import { AgentValidationError } from '@server/utils/agentValidation';
import { BadRequestError, NotFoundError, UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';
import { ExpectedImageGenerationError } from '@bike4mind/utils';
import { ImageModerationBlockedError } from '@bike4mind/utils/imageModeration';
import { BadGatewayError } from '@bike4mind/server-utils/utils/errors';
import { SystemPromptRateLimitError } from './systemPromptRateLimit';
import { AuthoringResultError } from './authoring/authoringErrors';
import { toV1AgentError, toV1AuthoringError } from './v1AgentErrors';

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

describe('toV1AuthoringError', () => {
  it('keeps a typed HTTP error and its status', () => {
    const error = new BadRequestError('The assistant is disabled');
    expect(toV1AuthoringError(error)).toBe(error);
  });

  it('reports the per-agent generation interval as a 429, not the SPA route 400', () => {
    const mapped = toV1AuthoringError(new SystemPromptRateLimitError('Rate limit exceeded. Wait 30 seconds.'));
    expect(mapped).toMatchObject({ statusCode: 429, message: 'Rate limit exceeded. Wait 30 seconds.' });
  });

  it('surfaces the provider refusal message of an expected image failure as a 502', () => {
    const mapped = toV1AuthoringError(new ExpectedImageGenerationError('The prompt was refused'));
    expect(mapped).toBeInstanceOf(BadGatewayError);
    expect(mapped.message).toBe('The prompt was refused');
  });

  it('reports a moderation block as a 502 without the blocked image detail', () => {
    const mapped = toV1AuthoringError(
      new ImageModerationBlockedError([{ name: 'Explicit Nudity', confidence: 98.1 } as never])
    );
    expect(mapped).toBeInstanceOf(BadGatewayError);
    expect(mapped.message).not.toContain('Nudity');
  });

  it('reports an empty model result or a failed save as a 502, not a 400', () => {
    const mapped = toV1AuthoringError(new AuthoringResultError('Failed to enhance field. Please try again.'));
    expect(mapped).toBeInstanceOf(BadGatewayError);
    expect(new AuthoringResultError('x')).toBeInstanceOf(BadRequestError);
  });

  it('hides the text of any other failure behind a generic 502', () => {
    const mapped = toV1AuthoringError(new Error('401 sk-secret from upstream'));
    expect(mapped).toMatchObject({ statusCode: 502 });
    expect(mapped.message).not.toContain('sk-secret');
  });
});
