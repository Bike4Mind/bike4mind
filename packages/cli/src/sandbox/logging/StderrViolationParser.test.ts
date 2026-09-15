import { describe, it, expect } from 'vitest';
import {
  parseSeatbeltStderr,
  parseBwrapStderr,
  parseSandboxStderr,
  toSandboxViolations,
} from './StderrViolationParser.js';

describe('StderrViolationParser', () => {
  describe('parseSeatbeltStderr', () => {
    it('extracts single deny line with operation and path', () => {
      const stderr = 'sandbox-exec: deny(1) file-write-data /Users/foo/.ssh/id_rsa\n';
      const violations = parseSeatbeltStderr(stderr);

      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe('filesystem');
      expect(violations[0].operation).toBe('file-write-data');
      expect(violations[0].path).toBe('/Users/foo/.ssh/id_rsa');
    });

    it('extracts multiple deny lines in mixed stderr', () => {
      const stderr = [
        'some normal output',
        'sandbox-exec: deny(1) file-write-data /tmp/foo',
        'more output',
        'sandbox-exec: deny(1) file-read-data /etc/shadow',
        'final output',
      ].join('\n');

      const violations = parseSeatbeltStderr(stderr);
      expect(violations).toHaveLength(2);
      expect(violations[0].path).toBe('/tmp/foo');
      expect(violations[1].path).toBe('/etc/shadow');
    });

    it('classifies file-write-data as filesystem', () => {
      const stderr = 'sandbox-exec: deny(1) file-write-data /tmp/test\n';
      const violations = parseSeatbeltStderr(stderr);
      expect(violations[0].type).toBe('filesystem');
    });

    it('classifies network-outbound as network', () => {
      const stderr = 'sandbox-exec: deny(1) network-outbound /private/var/run/mDNSResponder\n';
      const violations = parseSeatbeltStderr(stderr);

      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe('network');
      expect(violations[0].operation).toBe('network-outbound');
    });

    it('returns empty array for non-matching stderr', () => {
      const stderr = 'normal program output\nno errors here\n';
      const violations = parseSeatbeltStderr(stderr);
      expect(violations).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      expect(parseSeatbeltStderr('')).toEqual([]);
    });
  });

  describe('parseBwrapStderr', () => {
    it('extracts Permission denied message', () => {
      const stderr = "bwrap: Can't open file /etc/shadow: Permission denied\n";
      const violations = parseBwrapStderr(stderr);

      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe('filesystem');
      expect(violations[0].path).toBe('/etc/shadow');
    });

    it('extracts bind mount error', () => {
      const stderr = "bwrap: Can't bind mount /home/user/.ssh\n";
      const violations = parseBwrapStderr(stderr);

      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe('filesystem');
      expect(violations[0].path).toBe('/home/user/.ssh');
    });

    it('returns empty array for non-matching stderr', () => {
      const stderr = 'program output\nno bwrap errors\n';
      expect(parseBwrapStderr(stderr)).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      expect(parseBwrapStderr('')).toEqual([]);
    });
  });

  describe('parseSandboxStderr', () => {
    it('auto-detects Seatbelt violations', () => {
      const stderr = 'sandbox-exec: deny(1) file-write-data /tmp/test\n';
      const violations = parseSandboxStderr(stderr);
      expect(violations).toHaveLength(1);
      expect(violations[0].operation).toBe('file-write-data');
    });

    it('auto-detects Bubblewrap violations', () => {
      const stderr = "bwrap: Can't open file /etc/shadow: Permission denied\n";
      const violations = parseSandboxStderr(stderr);
      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe('filesystem');
    });

    it('returns empty for unrelated stderr', () => {
      expect(parseSandboxStderr('all good\n')).toEqual([]);
    });
  });

  describe('toSandboxViolations', () => {
    it('converts parsed violations to SandboxViolation records', () => {
      const parsed = parseSeatbeltStderr('sandbox-exec: deny(1) file-write-data /tmp/test\n');
      const violations = toSandboxViolations(parsed, 'rm -rf /tmp/test');

      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe('filesystem');
      expect(violations[0].path).toBe('/tmp/test');
      expect(violations[0].command).toBe('rm -rf /tmp/test');
      expect(violations[0].blockedBy).toBe('sandbox');
      expect(violations[0].timestamp).toBeInstanceOf(Date);
      expect(violations[0].detail).toContain('sandbox-exec');
    });
  });
});
