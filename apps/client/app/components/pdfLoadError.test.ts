// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createPdfWorkerStartError, describePdfLoadError } from './pdfLoadError';

describe('describePdfLoadError', () => {
  it('classifies a worker/API version mismatch and points at reloading', () => {
    const err = Object.assign(new Error('The API version "6.3.289" does not match the Worker version "5.6.205".'), {
      name: 'UnknownErrorException',
    });

    const result = describePdfLoadError(err);

    expect(result.title).toBe('PDF viewer is out of date');
    expect(result.detail).toMatch(/Reload the page/);
    expect(result.detail).toMatch(/clear this site's data/);
    expect(result.technical).toBe(
      'UnknownErrorException: The API version "6.3.289" does not match the Worker version "5.6.205".'
    );
  });

  it('classifies an invalid/corrupt PDF', () => {
    const err = Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' });

    const result = describePdfLoadError(err);

    expect(result.title).toBe('This file is not a valid PDF');
    expect(result.detail).toMatch(/damaged/);
    expect(result.technical).toBe('InvalidPDFException: Invalid PDF structure.');
  });

  it('classifies a password-protected PDF', () => {
    const err = Object.assign(new Error('No password given'), { name: 'PasswordException', code: 1 });

    const result = describePdfLoadError(err);

    expect(result.title).toBe('This PDF is password-protected');
    expect(result.detail).toMatch(/password/);
    expect(result.technical).toBe('PasswordException: No password given');
  });

  it.each([401, 403])('classifies a %i response as an expired/revoked link', status => {
    const err = Object.assign(new Error('Unexpected server response'), {
      name: 'ResponseException',
      status,
      missing: false,
    });

    const result = describePdfLoadError(err);

    expect(result.title).toBe('Access to this file has expired');
    expect(result.detail).toMatch(/fresh link/);
  });

  it('classifies a missing-file response as not found', () => {
    const err = Object.assign(new Error('Unexpected server response (404)'), {
      name: 'ResponseException',
      status: 404,
      missing: true,
    });

    const result = describePdfLoadError(err);

    expect(result.title).toBe('File not found');
    expect(result.detail).toMatch(/deleted or moved/);
  });

  it('classifies a response marked missing even without a 404 status', () => {
    const err = Object.assign(new Error('Unexpected server response'), {
      name: 'ResponseException',
      status: 0,
      missing: true,
    });

    expect(describePdfLoadError(err).title).toBe('File not found');
  });

  it('classifies any other response status as a server error and includes the status number', () => {
    const err = Object.assign(new Error('Unexpected server response (500)'), {
      name: 'ResponseException',
      status: 500,
      missing: false,
    });

    const result = describePdfLoadError(err);

    expect(result.title).toBe('The file server returned an error');
    expect(result.detail).toContain('500');
  });

  it('redacts a signed URL out of the technical details so a screenshot cannot leak credentials', () => {
    const err = Object.assign(
      new Error(
        'Unexpected server response (403) while retrieving PDF ' +
          '"https://bucket.s3.amazonaws.com/path/to/key.pdf?X-Amz-Signature=secret&X-Amz-Credential=abc".'
      ),
      { name: 'ResponseException', status: 403, missing: false }
    );

    const result = describePdfLoadError(err);

    expect(result.technical).toContain('bucket.s3.amazonaws.com/path/to/key.pdf');
    expect(result.technical).not.toContain('X-Amz-Signature');
    expect(result.technical).not.toContain('secret');
    expect(result.technical).not.toContain('?');
  });

  it('classifies a network failure from a fetch TypeError', () => {
    const err = new TypeError('Failed to fetch');

    const result = describePdfLoadError(err);

    expect(result.title).toBe('Could not download the file');
    expect(result.detail).toMatch(/connection/);
    expect(result.technical).toBe('TypeError: Failed to fetch');
  });

  it('classifies a NetworkError message even when the error name is generic', () => {
    const err = new Error('NetworkError when attempting to fetch resource.');

    expect(describePdfLoadError(err).title).toBe('Could not download the file');
  });

  it('classifies a Safari "Load failed" TypeError as the network error', () => {
    const err = new TypeError('Load failed');

    expect(describePdfLoadError(err).title).toBe('Could not download the file');
  });

  it('does not classify an unrelated TypeError as a network error', () => {
    const err = new TypeError('Cannot read properties of undefined');

    const result = describePdfLoadError(err);

    expect(result.title).toBe('Unable to load PDF document');
  });

  it('classifies a fake-worker startup failure', () => {
    const err = new Error('Setting up fake worker failed: "importScripts is not defined".');

    const result = describePdfLoadError(err);

    expect(result.title).toBe('PDF viewer failed to start');
    expect(result.detail).toMatch(/Reload the page/);
  });

  it('classifies a dedicated-worker startup failure and mentions a deploy', () => {
    const event = Object.assign(new Event('error'), {
      message: 'SyntaxError: Unexpected token <',
      filename: 'https://app.example.test/pdf.worker-6.3.289.min.mjs',
    });

    const err = createPdfWorkerStartError(event);
    const result = describePdfLoadError(err);

    expect(err.name).toBe('PdfWorkerStartError');
    expect(result.title).toBe('PDF viewer failed to start');
    expect(result.detail).toMatch(/deploy/);
    expect(result.detail).toMatch(/Reload the page/);
    expect(result.technical).toBe(
      'PdfWorkerStartError: PDF worker failed to start (error event): SyntaxError: Unexpected token < in ' +
        'https://app.example.test/pdf.worker-6.3.289.min.mjs'
    );
  });

  it('describes a worker startup failure from a bare event with no message', () => {
    const result = describePdfLoadError(createPdfWorkerStartError(new Event('messageerror')));

    expect(result.title).toBe('PDF viewer failed to start');
    expect(result.technical).toBe('PdfWorkerStartError: PDF worker failed to start (messageerror event)');
  });

  it('falls back to a default message for an unrecognised error', () => {
    const err = new Error('Something exploded');

    const result = describePdfLoadError(err);

    expect(result.title).toBe('Unable to load PDF document');
    expect(result.detail).toMatch(/Reload the page/);
    expect(result.technical).toBe('Error: Something exploded');
  });

  it('falls back to a default message for a non-Error, non-object thrown value', () => {
    const result = describePdfLoadError('a plain string failure');

    expect(result.title).toBe('Unable to load PDF document');
    expect(result.technical).toBe('a plain string failure');
  });

  it('falls back to a default message for undefined', () => {
    const result = describePdfLoadError(undefined);

    expect(result.title).toBe('Unable to load PDF document');
    expect(result.technical).toBe('undefined');
  });
});
