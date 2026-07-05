import { describe, it, expect } from 'vitest';
import { SreClassification } from '@bike4mind/common';
import { classifyError } from './logToSlackClassify';

describe('classifyError', () => {
  describe('transient socket / TLS drops → SKIP', () => {
    // A real production stack trace (frontend-server lambda).
    const terminatedStack = [
      'TypeError: terminated',
      '    at Fetch.onAborted (node:internal/deps/undici/undici:13602:53)',
      '    at Fetch.emit (node:events:508:28)',
      '  [cause]: SocketError: other side closed',
      "    code: 'UND_ERR_SOCKET',",
    ].join('\n');

    it('skips the full undici "terminated" socket-close stack', () => {
      expect(classifyError(terminatedStack)).toBe(SreClassification.SKIP);
    });

    it('skips bare UND_ERR_SOCKET', () => {
      expect(classifyError("SocketError: other side closed code: 'UND_ERR_SOCKET'")).toBe(SreClassification.SKIP);
    });

    it('skips "socket hang up"', () => {
      expect(classifyError('Error: socket hang up\n    at TLSSocket.onError')).toBe(SreClassification.SKIP);
    });

    it('takes precedence over the TypeError→MEDIUM rule', () => {
      // Regression guard: a "terminated" TypeError must NOT fall through to MEDIUM,
      // which would cause it to be auto-filed as a bug.
      expect(classifyError('TypeError: terminated')).not.toBe(SreClassification.MEDIUM);
      expect(classifyError('TypeError: terminated')).toBe(SreClassification.SKIP);
    });

    it('does NOT suppress genuine errors that merely contain the word "terminated"', () => {
      // The skip rule is scoped to undici signatures, not the bare word - real
      // incidents must still be classified/filed.
      expect(classifyError('Error: Worker thread terminated\n    at foo (file.js:1:1)')).toBe(SreClassification.LOW);
      expect(classifyError('Error: database connection terminated unexpectedly\n    at db (pg.js:9:9)')).toBe(
        SreClassification.LOW
      );
    });
  });

  describe('preserved existing behavior', () => {
    it('still flags genuine TypeErrors as MEDIUM', () => {
      expect(classifyError("TypeError: Cannot read properties of undefined (reading 'x')")).toBe(
        SreClassification.MEDIUM
      );
    });

    it('still flags ZodError as HIGH', () => {
      expect(classifyError('ZodError: invalid input')).toBe(SreClassification.HIGH);
    });

    it('still skips aborts', () => {
      expect(classifyError('AbortError: The operation was aborted')).toBe(SreClassification.SKIP);
    });

    it('still skips ECONNREFUSED / ETIMEDOUT', () => {
      expect(classifyError('Error: connect ECONNREFUSED 127.0.0.1:5432')).toBe(SreClassification.SKIP);
      expect(classifyError('Error: ETIMEDOUT')).toBe(SreClassification.SKIP);
    });

    it('classifies an unknown error with a stack trace as LOW', () => {
      expect(classifyError('SomeWeirdError: boom\n    at foo (file.js:1:1)')).toBe(SreClassification.LOW);
    });

    it('skips an unknown error with no stack trace', () => {
      expect(classifyError('just a plain string')).toBe(SreClassification.SKIP);
    });
  });
});
