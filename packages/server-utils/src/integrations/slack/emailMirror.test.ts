import { describe, it, expect } from 'vitest';
import {
  redactEmailContentForMirror,
  inferEmailType,
  extractBodyPreview,
  buildEmailMirrorMessage,
  EMAIL_PREVIEW_MAX_CHARS,
} from './emailMirror';

describe('redactEmailContentForMirror', () => {
  it('strips the token from a verification/reset link query string but keeps the destination', () => {
    const out = redactEmailContentForMirror(
      'Verify: https://app.staging.bike4mind.com/verify?token=abcdef0123456789abcdef0123456789'
    );
    expect(out).toContain('https://app.staging.bike4mind.com/verify?<redacted>');
    expect(out).not.toContain('abcdef0123456789abcdef0123456789');
  });

  it('redacts a token carried in the URL path (not just the query)', () => {
    const out = redactEmailContentForMirror(
      'Reset: https://app.bike4mind.com/reset/9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc'
    );
    expect(out).not.toContain('9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc');
    expect(out).toContain('<redacted>');
  });

  it('redacts a JWT as a single unit', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjY2ZmJhMGE1MDQxZmVlYTk5YmE3NWY4NSJ9.abc123DEF456ghi789JKL012mno345PQR';
    const out = redactEmailContentForMirror(`Your token is ${jwt} — do not share`);
    expect(out).toContain('<redacted-jwt>');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts bare long opaque tokens anywhere in the text', () => {
    const out = redactEmailContentForMirror('code: A1b2C3d4E5f6G7h8I9j0K1l2M3n4');
    expect(out).toBe('code: <redacted>');
  });

  it('leaves normal prose and short words untouched', () => {
    const prose = 'Welcome to Bike4Mind! Your account is ready. Click below to get started.';
    expect(redactEmailContentForMirror(prose)).toBe(prose);
  });

  it('returns empty string for empty/null/undefined input', () => {
    expect(redactEmailContentForMirror('')).toBe('');
    expect(redactEmailContentForMirror(null)).toBe('');
    expect(redactEmailContentForMirror(undefined)).toBe('');
  });
});

describe('inferEmailType', () => {
  it.each([
    ['Verify your email address', 'email-verification'],
    ['Confirm your email', 'email-verification'],
    ['Reset your password', 'password-reset'],
    ['Password reset request', 'password-reset'],
    ['Confirm your email change', 'email-change'],
    ["You've been invited to Bike4Mind", 'invite'],
    ['Welcome to Bike4Mind', 'welcome'],
    ['Your credits have been granted', 'credit-grant'],
    ["What's New in Bike4Mind", 'whats-new'],
    ['System Health Test Email', 'system-health'],
    ['Some unrelated subject', 'other'],
    ['', 'unknown'],
  ])('classifies %j as %j', (subject, expected) => {
    expect(inferEmailType(subject)).toBe(expected);
  });

  it('prefers email-change over generic verification when both could match', () => {
    expect(inferEmailType('Verify your new email address change')).toBe('email-change');
  });
});

describe('extractBodyPreview', () => {
  it('prefers the text body and redacts it', () => {
    const preview = extractBodyPreview({
      text: 'Reset here: https://app.bike4mind.com/reset?token=supersecrettoken1234567890abcd',
    });
    expect(preview).toContain('https://app.bike4mind.com/reset?<redacted>');
    expect(preview).not.toContain('supersecrettoken1234567890abcd');
  });

  it('falls back to HTML (tags stripped) when no text body', () => {
    const preview = extractBodyPreview({ html: '<h2>Welcome</h2><p>Your account is <b>ready</b>.</p>' });
    expect(preview).toBe('Welcome Your account is ready.');
  });

  it('truncates long bodies to the preview cap with an ellipsis', () => {
    // Use normal short words (a long alphanumeric run would itself be redacted as token-shaped).
    const preview = extractBodyPreview({ text: 'word '.repeat(EMAIL_PREVIEW_MAX_CHARS) });
    expect(preview.length).toBe(EMAIL_PREVIEW_MAX_CHARS + 1); // + ellipsis char
    expect(preview.endsWith('…')).toBe(true);
  });

  it('returns empty string when neither text nor html is present', () => {
    expect(extractBodyPreview({ subject: 'no body' })).toBe('');
    expect(extractBodyPreview(undefined)).toBe('');
  });
});

describe('buildEmailMirrorMessage', () => {
  it('includes recipient, subject, type, and the redacted preview', () => {
    const msg = buildEmailMirrorMessage({
      to: 'user@example.com',
      subject: 'Reset your password',
      emailType: 'password-reset',
      bodyPreview: 'Reset here: https://app.bike4mind.com/reset?<redacted>',
    });
    expect(msg).toContain('password-reset');
    expect(msg).toContain('*To:* user@example.com');
    expect(msg).toContain('*Subject:* Reset your password');
    expect(msg).toContain('Preview (secrets redacted)');
  });

  it('omits the preview line when there is no body preview', () => {
    const msg = buildEmailMirrorMessage({
      to: 'user@example.com',
      subject: 'Welcome',
      emailType: 'welcome',
      bodyPreview: '',
    });
    expect(msg).not.toContain('Preview');
  });
});
