import { AxiosError } from 'axios';
import { describe, expect, it } from 'vitest';
import { GENERATION_ACCOUNT_CANNOT_PAY_MESSAGE, GENERATION_RATE_LIMITED_MESSAGE } from './generationErrors';
import { describeVideoGenerationError } from './videoGenerationErrors';

const FALLBACK = 'Could not start the video. Try again.';
const axiosError = (status: number, data: unknown) =>
  Object.assign(new AxiosError('Request failed'), { response: { status, data } });

describe('describeVideoGenerationError', () => {
  it('maps an errorCode to its message', () => {
    const error = axiosError(422, { error: 'x', request_id: 'r', errorCode: 'insufficient_credits' });
    expect(describeVideoGenerationError(error, FALLBACK)).toBe('You do not have enough credits for this video.');
  });

  it('maps a 404 input_image_not_found', () => {
    const error = axiosError(404, { error: 'x', request_id: 'r', errorCode: 'input_image_not_found' });
    expect(describeVideoGenerationError(error, FALLBACK)).toBe('The selected image was not found. Pick another image.');
  });

  it('never echoes the server text, even without a code', () => {
    const error = axiosError(500, { error: 'upstream said: quota exceeded for project 42', request_id: 'r' });
    expect(describeVideoGenerationError(error, FALLBACK)).toBe(FALLBACK);
  });

  it('ignores a code it does not know', () => {
    const error = axiosError(422, { error: 'x', request_id: 'r', errorCode: 'something_new' });
    expect(describeVideoGenerationError(error, FALLBACK)).toBe(FALLBACK);
  });

  it('explains a rate limit', () => {
    expect(describeVideoGenerationError(axiosError(429, { error: 'x' }), FALLBACK)).toBe(
      GENERATION_RATE_LIMITED_MESSAGE
    );
  });

  it('falls back for a non-HTTP error', () => {
    expect(describeVideoGenerationError(new Error('network'), FALLBACK)).toBe(FALLBACK);
  });
});

describe('describeVideoGenerationError billing context', () => {
  const personal = { name: 'Me', personal: true };
  const org = { name: 'Acme', personal: false };
  const insufficient = () => axiosError(422, { error: 'x', errorCode: 'insufficient_credits' });

  it('tells the user to switch accounts on a 403 while an organization account is billed', () => {
    expect(describeVideoGenerationError(axiosError(403, { error: 'x' }), FALLBACK, org)).toBe(
      GENERATION_ACCOUNT_CANNOT_PAY_MESSAGE
    );
  });

  it('keeps the fallback for a 403 on a personal or unselected account, which sends no organization', () => {
    const forbidden = axiosError(403, { error: 'x' });
    expect(describeVideoGenerationError(forbidden, FALLBACK, personal)).toBe(FALLBACK);
    expect(describeVideoGenerationError(forbidden, FALLBACK, null)).toBe(FALLBACK);
  });

  it('keeps the fallback for a 403 without billing context', () => {
    expect(describeVideoGenerationError(axiosError(403, { error: 'x' }), FALLBACK)).toBe(FALLBACK);
  });

  it('names the paying account when credits run out', () => {
    expect(describeVideoGenerationError(insufficient(), FALLBACK, personal)).toBe(
      'Your personal credits are not enough for this video.'
    );
    expect(describeVideoGenerationError(insufficient(), FALLBACK, org)).toBe(
      'Acme does not have enough credits for this video.'
    );
    expect(describeVideoGenerationError(insufficient(), FALLBACK, null)).toBe(
      'You do not have enough credits for this video.'
    );
  });

  it('lets a rate limit win over the billing message', () => {
    expect(describeVideoGenerationError(axiosError(429, {}), FALLBACK, org)).toBe(GENERATION_RATE_LIMITED_MESSAGE);
  });
});
