import { AxiosError, type AxiosResponse } from 'axios';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));

import { compositionErrorIssues, compositionErrorMessage } from './studioCompositions';

const httpError = (status: number, data: unknown) =>
  new AxiosError('failed', undefined, undefined, undefined, { status, data } as AxiosResponse);

const ISSUE = { code: 'unknown_file', path: ['tracks', 0, 'clips', 0, 'fileId'], message: 'No such file' };

describe('compositionErrorMessage', () => {
  it('reads the shared error envelope', () => {
    expect(compositionErrorMessage(httpError(422, { error: 'Invalid composition', issues: [] }))).toBe(
      'Invalid composition'
    );
  });

  it("reads a route's inline message", () => {
    expect(compositionErrorMessage(httpError(404, { message: 'Composition not found' }))).toBe('Composition not found');
  });

  it('falls back to a generic message', () => {
    expect(compositionErrorMessage(new Error('boom'))).toBe('Something went wrong. Try again.');
    expect(compositionErrorMessage(httpError(500, 'Bad gateway'))).toBe('Something went wrong. Try again.');
  });
});

describe('compositionErrorIssues', () => {
  it('returns the well-formed issues of a 422', () => {
    expect(
      compositionErrorIssues(httpError(422, { error: 'Invalid composition', issues: [ISSUE, { junk: 1 }] }))
    ).toEqual([ISSUE]);
  });

  it('returns nothing for other statuses or bodies', () => {
    expect(compositionErrorIssues(httpError(400, { issues: [ISSUE] }))).toEqual([]);
    expect(compositionErrorIssues(httpError(422, 'nope'))).toEqual([]);
    expect(compositionErrorIssues(new Error('boom'))).toEqual([]);
  });
});
