import { describe, it, expect } from 'vitest';
import { redactSecrets, enforceOutputCeiling, sanitizeToolOutput, MAX_TOOL_OUTPUT_CHARS } from './toolOutputSanitizer';

describe('redactSecrets', () => {
  it('redacts a credentialed mongodb connection string', () => {
    const out = redactSecrets('failed to connect: mongodb+srv://admin:s3cr3tPass@cluster0.mongodb.net/db');
    expect(out).not.toContain('s3cr3tPass');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts postgres/redis credentialed URIs', () => {
    expect(redactSecrets('postgres://user:hunter2@db:5432/app')).not.toContain('hunter2');
    expect(redactSecrets('redis://default:topsecret@cache:6379')).not.toContain('topsecret');
  });

  it('redacts Anthropic, OpenAI, and Stripe keys', () => {
    const anthropic = 'sk-ant-api03-' + 'a'.repeat(40);
    const openai = 'sk-' + 'b'.repeat(30);
    const stripe = 'sk_live_' + 'c'.repeat(24);
    const out = redactSecrets(`${anthropic} ${openai} ${stripe}`);
    expect(out).not.toContain('a'.repeat(40));
    expect(out).not.toContain('b'.repeat(30));
    expect(out).not.toContain('c'.repeat(24));
  });

  it('redacts AWS access key IDs and GitHub tokens', () => {
    const aws = 'AKIA' + 'A'.repeat(16);
    const gh = 'ghp_' + 'd'.repeat(36);
    const out = redactSecrets(`${aws} and ${gh}`);
    expect(out).not.toContain(aws);
    expect(out).not.toContain(gh);
  });

  it('redacts a Gemini key whose 35th char is a hyphen next to punctuation', () => {
    const out = redactSecrets('leak: AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345- oh no');
    expect(out).not.toContain('AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345-');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts a bare Stripe webhook signing secret (no test/live infix)', () => {
    const out = redactSecrets('seen in error: whsec_1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p');
    expect(out).not.toContain('whsec_1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.' + 'x'.repeat(30);
    expect(redactSecrets(jwt)).not.toContain(jwt);
  });

  it('keeps the Bearer scheme but redacts the token', () => {
    const out = redactSecrets('Authorization: Bearer abcdef1234567890XYZ');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('abcdef1234567890XYZ');
  });

  it('redacts the value of a secret-named assignment, keeping the key', () => {
    const out = redactSecrets('MY_API_KEY=super-secret-value-123');
    expect(out).toContain('MY_API_KEY');
    expect(out).not.toContain('super-secret-value-123');
    expect(out).toContain('[REDACTED]');
  });

  it('leaves ordinary tool output untouched', () => {
    const content = 'export function add(a: number, b: number) { return a + b; }\n/Users/dev/project/src/add.ts:1';
    expect(redactSecrets(content)).toBe(content);
  });
});

describe('enforceOutputCeiling', () => {
  it('returns short output unchanged', () => {
    expect(enforceOutputCeiling('small', 100)).toBe('small');
  });

  it('truncates oversize output and appends a marker', () => {
    const out = enforceOutputCeiling('x'.repeat(50), 10);
    expect(out.startsWith('x'.repeat(10))).toBe(true);
    expect(out).toContain('[output truncated:');
    expect(out).toContain('40 of 50 characters omitted');
  });

  it('defaults to MAX_TOOL_OUTPUT_CHARS', () => {
    const out = enforceOutputCeiling('y'.repeat(MAX_TOOL_OUTPUT_CHARS + 5));
    expect(out).toContain('[output truncated:');
  });
});

describe('sanitizeToolOutput', () => {
  it('redacts before truncating so a boundary-straddling secret cannot leak', () => {
    const secret = 'sk-' + 'z'.repeat(30);
    // Pad so the secret sits right at the truncation boundary.
    const text = 'a'.repeat(8) + secret;
    const out = sanitizeToolOutput(text, 12);
    expect(out).not.toContain('z'.repeat(30));
  });

  it('applies both redaction and the ceiling', () => {
    const secret = 'ghp_' + 'e'.repeat(36);
    const out = sanitizeToolOutput(`${secret} ${'p'.repeat(200)}`, 50);
    expect(out).not.toContain(secret);
    expect(out).toContain('[output truncated:');
  });
});
