import { describe, it, expect } from 'vitest';
import { sanitizeErrorMessage } from '../error';

describe('sanitizeErrorMessage', () => {
  describe('GitHub token sanitization', () => {
    it('should redact GitHub PAT (classic)', () => {
      // nosemgrep: generic.secrets.security.detected-github-token.detected-github-token
      const input = 'Invalid token: ghp_1234567890abcdefABCDEF1234567890abcd';
      expect(sanitizeErrorMessage(input)).toBe('Invalid token: [REDACTED]');
    });

    it('should redact GitHub OAuth token (gho_)', () => {
      // gho_ tokens have exactly 36 chars after prefix
      // nosemgrep: generic.secrets.security.detected-github-token.detected-github-token
      const input = 'Token expired: gho_abcdefghijklmnopqrstuvwxyz1234567890';
      expect(sanitizeErrorMessage(input)).toBe('Token expired: [REDACTED]');
    });

    it('should redact GitHub user-to-server token (ghu_)', () => {
      // ghu_ tokens have exactly 36 chars after prefix
      // nosemgrep: generic.secrets.security.detected-github-token.detected-github-token
      const input = 'Auth failed: ghu_abcdefghijklmnopqrstuvwxyz1234567890';
      expect(sanitizeErrorMessage(input)).toBe('Auth failed: [REDACTED]');
    });

    it('should redact GitHub server-to-server token (ghs_, classic 40-char)', () => {
      // classic opaque ghs_ tokens have 36 chars after the prefix
      // nosemgrep: generic.secrets.security.detected-github-token.detected-github-token
      const input = 'Server error: ghs_abcdefghijklmnopqrstuvwxyz1234567890';
      expect(sanitizeErrorMessage(input)).toBe('Server error: [REDACTED]');
    });

    it('should redact GitHub server-to-server token (ghs_, new stateless JWT format)', () => {
      // New installation-token format: ghs_ + base64url JWT (~520 chars, two dots).
      // https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header/
      // nosemgrep: generic.secrets.security.detected-github-token.detected-github-token, generic.secrets.security.detected-jwt-token.detected-jwt-token
      // Public jwt.io sample token used as a test fixture to verify redaction - not a real credential.
      const jwt =
        'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiIyNzg1MTkwIiwiaWF0IjoxNzA5MzAwMDAwLCJleHAiOjE3MDkzMDM2MDB9.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const input = `Server error: ghs_${jwt} was rejected`;
      expect(sanitizeErrorMessage(input)).toBe('Server error: [REDACTED] was rejected');
    });

    it('should redact GitHub refresh token (ghr_)', () => {
      // ghr_ tokens have exactly 36 chars after prefix
      // nosemgrep: generic.secrets.security.detected-github-token.detected-github-token
      const input = 'Refresh failed: ghr_abcdefghijklmnopqrstuvwxyz1234567890';
      expect(sanitizeErrorMessage(input)).toBe('Refresh failed: [REDACTED]');
    });

    it('should redact fine-grained PAT (github_pat_)', () => {
      // nosemgrep: generic.secrets.security.detected-github-token.detected-github-token
      const input = 'Auth failed with github_pat_abc123def456ghijklmnopqr';
      expect(sanitizeErrorMessage(input)).toBe('Auth failed with [REDACTED]');
    });
  });

  describe('PEM key sanitization', () => {
    it('should redact PEM private keys', () => {
      const input = 'Key error: -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
      expect(sanitizeErrorMessage(input)).toBe('Key error: [REDACTED]');
    });

    it('should redact certificate blocks', () => {
      const input = 'Cert issue: -----BEGIN CERTIFICATE-----\nMIIDdzCCAl...\n-----END CERTIFICATE-----';
      expect(sanitizeErrorMessage(input)).toBe('Cert issue: [REDACTED]');
    });
  });

  describe('AWS credential sanitization', () => {
    it('should redact AWS Access Key ID (AKIA)', () => {
      const input = 'AWS error with key AKIAIOSFODNN7EXAMPLE';
      expect(sanitizeErrorMessage(input)).toBe('AWS error with key [REDACTED]');
    });

    it('should redact AWS temporary Access Key ID (ASIA)', () => {
      const input = 'Session error: ASIAIOSFODNN7EXAMPLE';
      expect(sanitizeErrorMessage(input)).toBe('Session error: [REDACTED]');
    });
  });

  describe('key=value pattern sanitization', () => {
    it('should redact appId=value patterns', () => {
      const input = 'Error: appId=12345 failed';
      expect(sanitizeErrorMessage(input)).toBe('Error: [REDACTED] failed');
    });

    it('should redact accessToken patterns', () => {
      const input = 'Failed with accessToken: "secrettoken123"';
      expect(sanitizeErrorMessage(input)).toBe('Failed with [REDACTED]');
    });

    it('should redact client_secret patterns', () => {
      const input = 'OAuth error: client_secret=mysecret123';
      expect(sanitizeErrorMessage(input)).toBe('OAuth error: [REDACTED]');
    });

    it('should redact api_key patterns', () => {
      const input = 'Request failed: api_key="abc123xyz"';
      expect(sanitizeErrorMessage(input)).toBe('Request failed: [REDACTED]');
    });
  });

  describe('hex string sanitization', () => {
    it('should redact 40+ character hex strings', () => {
      const input = 'Token: abcdef0123456789abcdef0123456789abcdef01';
      expect(sanitizeErrorMessage(input)).toBe('Token: [REDACTED]');
    });

    it('should redact very long hex strings', () => {
      const input = 'Hash: abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
      expect(sanitizeErrorMessage(input)).toBe('Hash: [REDACTED]');
    });
  });

  describe('normal messages preservation', () => {
    it('should preserve normal error messages', () => {
      const input = 'Authentication failed: invalid credentials';
      expect(sanitizeErrorMessage(input)).toBe('Authentication failed: invalid credentials');
    });

    it('should not over-redact common words', () => {
      const input = 'Application installation failed';
      expect(sanitizeErrorMessage(input)).toBe('Application installation failed');
    });

    it('should preserve connection timeout messages', () => {
      const input = 'Connection timed out after 30 seconds';
      expect(sanitizeErrorMessage(input)).toBe('Connection timed out after 30 seconds');
    });

    it('should preserve rate limit messages', () => {
      const input = 'Rate limit exceeded. Please try again later.';
      expect(sanitizeErrorMessage(input)).toBe('Rate limit exceeded. Please try again later.');
    });

    it('should preserve permission denied messages', () => {
      const input = 'Permission denied: insufficient access rights';
      expect(sanitizeErrorMessage(input)).toBe('Permission denied: insufficient access rights');
    });
  });

  describe('multiple patterns', () => {
    it('should redact multiple sensitive values in one message', () => {
      // ghp_ tokens require 36+ chars after prefix
      // nosemgrep: generic.secrets.security.detected-github-token.detected-github-token
      const input = 'Auth failed for appId=123 with token ghp_abcdefghijklmnopqrstuvwxyz1234567890';
      const result = sanitizeErrorMessage(input);
      expect(result).toBe('Auth failed for [REDACTED] with token [REDACTED]');
    });
  });
});
