import { describe, expect, it } from 'vitest';
import {
  CorruptedFileError,
  isPasswordProtectedPdfError,
  PASSWORD_PROTECTED_PDF_MESSAGE,
  PasswordProtectedFileError,
} from './errors';

describe('isPasswordProtectedPdfError', () => {
  it("matches pdf.js's PasswordException by name, whatever its message", () => {
    const needPassword = Object.assign(new Error('No password given'), { name: 'PasswordException', code: 1 });
    const incorrectPassword = Object.assign(new Error('Incorrect Password'), { name: 'PasswordException', code: 2 });

    expect(isPasswordProtectedPdfError(needPassword)).toBe(true);
    expect(isPasswordProtectedPdfError(incorrectPassword)).toBe(true);
  });

  it('matches the mapped error, including across a module boundary where instanceof fails', () => {
    expect(isPasswordProtectedPdfError(new PasswordProtectedFileError())).toBe(true);
    expect(isPasswordProtectedPdfError({ name: 'PasswordProtectedFileError' })).toBe(true);
  });

  it('does not match other errors, even ones that mention a password', () => {
    expect(isPasswordProtectedPdfError(new Error('No password given'))).toBe(false);
    expect(isPasswordProtectedPdfError(Object.assign(new Error('x'), { name: 'InvalidPDFException', code: 1 }))).toBe(
      false
    );
    expect(isPasswordProtectedPdfError(new CorruptedFileError('a.pdf', 'PDF'))).toBe(false);
    expect(isPasswordProtectedPdfError(undefined)).toBe(false);
    expect(isPasswordProtectedPdfError('PasswordException')).toBe(false);
  });
});

describe('PasswordProtectedFileError', () => {
  it('is a 422 carrying the user-facing message', () => {
    const error = new PasswordProtectedFileError();

    expect(error.statusCode).toBe(422);
    expect(error.message).toBe(PASSWORD_PROTECTED_PDF_MESSAGE);
  });
});
