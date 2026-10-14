import { AxiosError } from 'axios';
import { describe, expect, it } from 'vitest';
import { describeVideoGenerationError, VIDEO_RATE_LIMITED_MESSAGE } from './videoGenerationErrors';

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
    expect(describeVideoGenerationError(axiosError(429, { error: 'x' }), FALLBACK)).toBe(VIDEO_RATE_LIMITED_MESSAGE);
  });

  it('falls back for a non-HTTP error', () => {
    expect(describeVideoGenerationError(new Error('network'), FALLBACK)).toBe(FALLBACK);
  });
});
