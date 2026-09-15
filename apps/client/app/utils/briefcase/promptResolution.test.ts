import { describe, it, expect } from 'vitest';
import { replacePromptVariables, countUnresolvedPlaceholders, buildPromptContext } from './promptResolution';

describe('replacePromptVariables', () => {
  it('replaces every known placeholder', () => {
    expect(
      replacePromptVariables('Hi {{userName}} ({{organization}})', { userName: 'Ada', organization: 'Acme' })
    ).toBe('Hi Ada (Acme)');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(replacePromptVariables('Hello {{missing}}', { userName: 'Ada' })).toBe('Hello {{missing}}');
  });

  it('skips null/undefined values — no literal "null" leaks', () => {
    expect(replacePromptVariables('X {{userRole}} Y', { userRole: undefined })).toBe('X {{userRole}} Y');
    expect(replacePromptVariables('X {{organization}} Y', { organization: null as unknown as undefined })).toBe(
      'X {{organization}} Y'
    );
  });

  it('does not re-substitute a value that itself contains a placeholder (single pass)', () => {
    expect(
      replacePromptVariables('{{userName}} and {{organization}}', {
        userName: '{{organization}}',
        organization: 'SECRET',
      })
    ).toBe('{{organization}} and SECRET');
  });

  it('inserts $-sequences literally (function-form replace, no $& / $1 interpretation)', () => {
    expect(replacePromptVariables('Pay {{organization}}', { organization: '$5 for $1.00 ($$)' })).toBe(
      'Pay $5 for $1.00 ($$)'
    );
  });
});

describe('countUnresolvedPlaceholders', () => {
  it('counts remaining placeholders', () => {
    expect(countUnresolvedPlaceholders('a {{x}} b {{y}} c')).toBe(2);
    expect(countUnresolvedPlaceholders('none here')).toBe(0);
  });
});

describe('buildPromptContext', () => {
  it('maps user/org/clock fields onto the context', () => {
    const ctx = buildPromptContext(
      { name: 'Ada', email: 'ada@x.com', role: 'Engineer' },
      'Acme',
      new Date('2026-06-02T15:30:45.000Z')
    );
    expect(ctx).toMatchObject({
      organization: 'Acme',
      userName: 'Ada',
      userEmail: 'ada@x.com',
      userRole: 'Engineer',
      currentDate: '2026-06-02',
      currentTime: '15:30:45',
      currentYear: '2026',
    });
  });

  it('uses undefined for absent user/org (so placeholders are left untouched)', () => {
    const ctx = buildPromptContext(null, null, new Date('2026-06-02T00:00:00.000Z'));
    expect(ctx.organization).toBeUndefined();
    expect(ctx.userName).toBeUndefined();
  });
});
