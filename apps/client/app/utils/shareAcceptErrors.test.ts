import { describe, expect, it } from 'vitest';
import { AxiosError } from 'axios';
import { describeAcceptFailure } from './shareAcceptErrors';

const failure = (message: string) =>
  new AxiosError('fail', 'ERR', undefined, undefined, {
    status: 403,
    data: { name: 'ForbiddenError', error: message },
  } as never);

describe('describeAcceptFailure for Space joins', () => {
  it.each([
    ['This space is full', 'full'],
    ['You cannot join this space', 'removed'],
    ['Space not found', 'unavailable'],
    ['The inviter can no longer grant access to this space', 'unavailable'],
    ['Feature not available', 'unavailable'],
    ['You are already a member of this space', 'member'],
  ])('maps "%s" to the %s screen', (message, kind) => {
    expect(describeAcceptFailure(failure(message))?.kind).toBe(kind);
  });

  it('leaves an unknown failure to the default handling', () => {
    expect(describeAcceptFailure(failure('Something else'))).toBeNull();
  });

  it('leaves a non-axios error alone', () => {
    expect(describeAcceptFailure(new Error('boom'))).toBeNull();
  });
});
