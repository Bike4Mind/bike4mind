import { describe, it, expect } from 'vitest';
import { buildTestRecipients, type Recipient } from './emailJobOrchestrator';
import { dedupeTestRecipients } from './emailTestRecipients';

function makeRecipients(count: number): Recipient[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `user-${i}`,
    type: 'user' as const,
    email: `real${i}@example.com`,
  }));
}

describe('buildTestRecipients', () => {
  it('sends exactly one email per test address, not one per real recipient', () => {
    const realRecipients = makeRecipients(20);
    const testRecipients = ['test@example.com'];

    const result = buildTestRecipients(realRecipients, testRecipients);

    expect(result).toHaveLength(1);
    expect(result[0].email).toBe('test@example.com');
  });

  it('pairs each test address with a distinct real recipient for personalization', () => {
    const realRecipients = makeRecipients(5);
    const testRecipients = ['a@example.com', 'b@example.com', 'c@example.com'];

    const result = buildTestRecipients(realRecipients, testRecipients);

    expect(result).toHaveLength(3);
    expect(result.map(r => r.email)).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    expect(result.map(r => r.originalRecipient)).toEqual([
      'real0@example.com',
      'real1@example.com',
      'real2@example.com',
    ]);
    expect(result.every(r => r.isTestEmail)).toBe(true);
  });

  it('caps at the number of real recipients when there are more test addresses than real recipients', () => {
    const realRecipients = makeRecipients(2);
    const testRecipients = ['a@example.com', 'b@example.com', 'c@example.com'];

    const result = buildTestRecipients(realRecipients, testRecipients);

    expect(result).toHaveLength(2);
  });

  it('normalizes test email addresses', () => {
    const realRecipients = makeRecipients(1);
    const testRecipients = ['  Test@Example.com  '];

    const result = buildTestRecipients(realRecipients, testRecipients);

    expect(result[0].email).toBe('test@example.com');
  });

  it('returns an empty list when there are no real recipients', () => {
    expect(buildTestRecipients([], ['test@example.com'])).toEqual([]);
  });
});

// Regression guard for the composition the orchestrator relies on: without the
// dedupe, duplicate/mixed-case test addresses each consume a Math.min slot in
// buildTestRecipients and double-deliver to one inbox. This asserts dedupe-then-
// build yields one recipient per distinct inbox. (It exercises the composition
// directly, not the dispatch call site, so it does not by itself catch the dedupe
// call being removed from emailJobOrchestrator.)
describe('dedupeTestRecipients feeding buildTestRecipients', () => {
  it('sends one email per distinct inbox for duplicate/mixed-case test addresses', () => {
    const realRecipients = makeRecipients(5);
    const testRecipients = ['qa@example.com', 'QA@example.com', ' qa@example.com '];

    const result = buildTestRecipients(realRecipients, dedupeTestRecipients(testRecipients));

    expect(result).toHaveLength(1);
    expect(result[0].email).toBe('qa@example.com');
  });
});
