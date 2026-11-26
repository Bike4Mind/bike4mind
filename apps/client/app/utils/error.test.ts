// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import {
  getErrorMessage,
  getInsufficientCreditsMessage,
  getServerErrorField,
  getValidationViolationsMessage,
} from './error';

/** An axios rejection shaped like one from the shared error envelope (errorHandler.ts). */
const apiError = (status: number, data: unknown, headers: Record<string, string> | AxiosHeaders = {}): AxiosError => {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', config as never, {}, {
    status,
    statusText: '',
    data,
    headers,
    config,
  } as never);
};

describe('getErrorMessage', () => {
  const cloudFrontPage =
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><HTML><HEAD><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD>' +
    '<BODY><H1>403 ERROR</H1><H2>The request could not be satisfied.</H2></BODY></HTML>';

  describe('string bodies that are markup, not a message', () => {
    it('replaces an HTML error page served as text/html with the status message', () => {
      const error = apiError(403, cloudFrontPage, { 'content-type': 'text/html; charset=UTF-8' });

      expect(getErrorMessage(error)).toBe('Error: 403');
    });

    // The header alone decides here: the body would pass the markup check on its own merits.
    it('trusts a text/html content type even when the body does not start with a tag', () => {
      expect(getErrorMessage(apiError(502, 'Bad gateway', { 'content-type': 'text/html' }))).toBe('Error: 502');
    });

    it('reads the content type whatever the header casing, as axios builds it', () => {
      const headers = new AxiosHeaders({ 'Content-Type': 'text/html; charset=utf-8' });

      expect(getErrorMessage(apiError(504, 'Gateway timeout', headers))).toBe('Error: 504');
    });

    // A proxy can drop or rewrite the content type, so the body is checked too.
    it.each([
      ['an uppercase doctype', cloudFrontPage],
      ['a lowercase doctype after leading whitespace', '\n  <!doctype html><html><body>blocked</body></html>'],
      ['a bare html element', '<html><body>Forbidden</body></html>'],
      ['an uppercase element', '<HTML><BODY>Forbidden</BODY></HTML>'],
      ['an XML error document', '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code></Error>'],
    ])('replaces %s with the status message when no content type is sent', (_name, body) => {
      expect(getErrorMessage(apiError(403, body))).toBe('Error: 403');
    });
  });

  describe('string bodies that are plain text', () => {
    it('shows a plain-text body unchanged', () => {
      expect(getErrorMessage(apiError(429, 'Too many requests, try again shortly.'))).toBe(
        'Too many requests, try again shortly.'
      );
      expect(getErrorMessage(apiError(500, 'Upstream failed', { 'content-type': 'text/plain' }))).toBe(
        'Upstream failed'
      );
    });

    it('does not mistake a "<" in plain text for markup', () => {
      expect(getErrorMessage(apiError(422, 'Amount must be < 5 and > 1.'))).toBe('Amount must be < 5 and > 1.');
      expect(getErrorMessage(apiError(422, '< 5 credits left. Please top up.'))).toBe(
        '< 5 credits left. Please top up.'
      );
    });

    it('only treats a body that opens with a tag as markup', () => {
      expect(getErrorMessage(apiError(422, 'Names cannot contain <b> or <i> tags.'))).toBe(
        'Names cannot contain <b> or <i> tags.'
      );
    });

    // A caller falling back with `getErrorMessage(error) || fallback` needs an empty body to stay empty.
    it('returns an empty body as is', () => {
      expect(getErrorMessage(apiError(502, ''))).toBe('');
    });

    it('keeps an empty or blank text/html body as is', () => {
      const headers = { 'content-type': 'text/html' };
      expect(getErrorMessage(apiError(502, '', headers))).toBe('');
      expect(getErrorMessage(apiError(502, '  \n', headers))).toBe('  \n');
    });
  });

  describe('JSON object bodies', () => {
    it('keeps preferring message, then error, then the status', () => {
      expect(getErrorMessage(apiError(400, { message: 'Bad pack.', error: 'ignored' }))).toBe('Bad pack.');
      expect(getErrorMessage(apiError(400, { error: 'Bad pack.' }))).toBe('Bad pack.');
      expect(getErrorMessage(apiError(500, {}))).toBe('Error: 500');
    });
  });
});

describe('getInsufficientCreditsMessage', () => {
  it('returns the server message for a 422 tagged insufficient_credits', () => {
    const message = getInsufficientCreditsMessage(
      apiError(422, { errorCode: 'insufficient_credits', error: 'You do not have enough credits for session tagging.' })
    );

    expect(message).toBe('You do not have enough credits for session tagging.');
  });

  // Only `errorCode` distinguishes a billing state from an unrelated 422 (e.g. a Zod failure),
  // so an untagged 422 must fall through to the caller's own message.
  it('returns undefined for an untagged 422', () => {
    expect(getInsufficientCreditsMessage(apiError(422, { error: 'Validation failed' }))).toBeUndefined();
  });

  it('returns undefined for a different error code', () => {
    expect(
      getInsufficientCreditsMessage(apiError(422, { errorCode: 'spend_cap_exceeded', error: 'Cap hit' }))
    ).toBeUndefined();
  });

  it('returns undefined for a non-axios error', () => {
    expect(getInsufficientCreditsMessage(new Error('boom'))).toBeUndefined();
  });

  // The envelope writes the human text to `error`; `message` is the fallback for any route that
  // still returns the older shape. A tagged error with neither must not produce an empty toast.
  it('falls back to `message`, then to undefined when the body carries no text', () => {
    expect(getInsufficientCreditsMessage(apiError(422, { errorCode: 'insufficient_credits', message: 'Out.' }))).toBe(
      'Out.'
    );
    expect(getInsufficientCreditsMessage(apiError(422, { errorCode: 'insufficient_credits' }))).toBeUndefined();
  });
});

describe('getServerErrorField', () => {
  it('returns undefined for a non-axios error', () => {
    expect(getServerErrorField(new Error('x'))).toBeUndefined();
  });

  it('returns undefined when the error field is not a string', () => {
    expect(getServerErrorField({ isAxiosError: true, response: { data: { error: { code: 1 } } } })).toBeUndefined();
  });

  it('returns the server error string', () => {
    expect(getServerErrorField({ isAxiosError: true, response: { data: { error: 'boom' } } })).toBe('boom');
  });
});

describe('getValidationViolationsMessage', () => {
  it('returns the violation reasons instead of the bare "Validation failed"', () => {
    const message = getValidationViolationsMessage(
      apiError(422, {
        error: 'Validation failed',
        violations: [
          { type: 'forbidden_pattern', message: 'Provide a single self-contained component.', file: 'index.html' },
        ],
      })
    );

    expect(message).toBe('Provide a single self-contained component.');
  });

  it('joins several distinct reasons and counts the ones it leaves out', () => {
    const violations = ['A.', 'B', 'A.', 'C!', 'D.', 'E.'].map(message => ({ type: 'invalid_path', message }));

    expect(getValidationViolationsMessage(apiError(422, { error: 'Validation failed', violations }))).toBe(
      'A. B. C! (+2 more)'
    );
  });

  it('returns undefined when there are no usable violation messages', () => {
    expect(getValidationViolationsMessage(apiError(422, { error: 'Validation failed' }))).toBeUndefined();
    expect(getValidationViolationsMessage(apiError(422, { violations: [{ type: 'x' }, null, 'y'] }))).toBeUndefined();
    expect(getValidationViolationsMessage(new Error('boom'))).toBeUndefined();
  });
});
