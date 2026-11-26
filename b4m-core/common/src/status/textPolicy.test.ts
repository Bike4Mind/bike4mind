import { describe, expect, it } from 'vitest';
import { sanitizeMarkdown } from './markdown';
import { findUnfilledPlaceholders, incidentPublicTextLength, validatePublicText } from './textPolicy';
import { TEXT_LIMITS } from './types';

const options = { linkHosts: ['app.example.com'] };
const codes = (issues: { code: string }[]) => issues.map(issue => issue.code);

describe('hard errors', () => {
  it('enforces the field limits', () => {
    expect(validatePublicText('title', 'x'.repeat(TEXT_LIMITS.title), options).ok).toBe(true);
    expect(codes(validatePublicText('title', 'x'.repeat(TEXT_LIMITS.title + 1), options).errors)).toContain('too_long');
    expect(validatePublicText('updateBody', 'x'.repeat(TEXT_LIMITS.updateBody), options).ok).toBe(true);
    expect(validatePublicText('updateBody', 'x'.repeat(TEXT_LIMITS.updateBody + 1), options).ok).toBe(false);
    expect(validatePublicText('postmortemBody', 'x'.repeat(TEXT_LIMITS.postmortemBody), options).ok).toBe(true);
    expect(validatePublicText('postmortemBody', 'x'.repeat(TEXT_LIMITS.postmortemBody + 1), options).ok).toBe(false);
    expect(validatePublicText('componentDescription', 'x'.repeat(TEXT_LIMITS.componentDescription), options).ok).toBe(
      true
    );
    expect(
      validatePublicText('componentDescription', 'x'.repeat(TEXT_LIMITS.componentDescription + 1), options).ok
    ).toBe(false);
  });

  it('measures length after normalization and in code points', () => {
    expect(validatePublicText('title', `${'x'.repeat(TEXT_LIMITS.title)}\u200b\u202e`, options).ok).toBe(true);
    expect(validatePublicText('title', '\u{1F600}'.repeat(TEXT_LIMITS.title), options).ok).toBe(true);
  });

  it('requires text and keeps titles to one line', () => {
    expect(codes(validatePublicText('title', '   ', options).errors)).toContain('empty');
    expect(codes(validatePublicText('title', 'a\nb', options).errors)).toContain('multiline');
    expect(validatePublicText('updateBody', 'a\n\nb', options).ok).toBe(true);
  });

  it('rejects unfilled template placeholders', () => {
    const result = validatePublicText('updateBody', 'Affecting {component}. Next update {nextUpdate}.', options);
    expect(result.ok).toBe(false);
    expect(result.errors.filter(e => e.code === 'unfilled_placeholder').map(e => e.match)).toEqual([
      '{component}',
      '{nextUpdate}',
    ]);
    expect(findUnfilledPlaceholders('{a} {a} {b1} { c } {1x}')).toEqual(['{a}', '{b1}']);
  });

  it('returns the normalized text', () => {
    expect(validatePublicText('title', 'Ca\u200bfe\u0301', options).normalized).toBe('Caf\u00e9');
  });
});

describe('warnings', () => {
  const warn = (text: string, extra = {}) =>
    codes(validatePublicText('updateBody', text, { ...options, ...extra }).warnings);

  it.each([
    ['ip_address', 'Failing over from 10.0.3.14 now'],
    ['hostname', 'Seen on db-1.prod.internal'],
    ['resource_shape', 'Instance i-0123456789abcdef0 restarted'],
    ['resource_shape', 'See arn:partition:service:region:acct:thing'],
    ['email', 'Contact jane.doe@example.org'],
    ['object_id', 'Record 507f1f77bcf86cd799439011 failed'],
    ['ticket', 'Tracked in OPS-1234'],
    ['stack_trace', 'TypeError: x is not a function'],
    ['stack_trace', '  at handler (/srv/app/index.js:10:5)'],
  ])('lints %s', (code, text) => {
    expect(warn(text)).toContain(code);
  });

  it('is quiet on ordinary customer-facing text', () => {
    expect(warn('Some users may see slow responses in chat. We will post another update by 14:30 UTC.')).toEqual([]);
  });

  it('warns when a link will render as plain text, not when it is allowlisted', () => {
    const lost = validatePublicText('updateBody', 'see [x](https://evil.example.net/p)', options);
    expect(codes(lost.warnings)).toContain('link_plain_text');
    expect(lost.warnings.find(w => w.code === 'link_plain_text')?.match).toBe('https://evil.example.net/p');
    expect(warn('see [x](https://app.example.com/p)')).not.toContain('link_plain_text');
  });

  it('warns that raw HTML, images and headings render as text', () => {
    expect(warn('<b>x</b>')).toContain('raw_html');
    expect(warn('![a](https://app.example.com/a.png)')).toContain('image');
    expect(warn('# Title\ntext')).toContain('heading');
  });

  it('raises security-term warnings only for security-classified incidents', () => {
    expect(warn('An attacker used a vulnerability')).not.toContain('security_term');
    expect(warn('An attacker used a vulnerability', { classification: 'security' })).toContain('security_term');
    expect(warn('We changed how sign-in works.', { classification: 'security' })).toEqual([]);
  });

  it('tracks acknowledgement per warning code', () => {
    const text = 'Contact jane.doe@example.org at 10.0.0.1';
    const open = validatePublicText('updateBody', text, options);
    expect(open.unacknowledged.map(w => w.code).sort()).toEqual(['email', 'ip_address']);
    const partly = validatePublicText('updateBody', text, { ...options, acknowledged: ['email'] });
    expect(partly.unacknowledged.map(w => w.code)).toEqual(['ip_address']);
    expect(
      validatePublicText('updateBody', text, { ...options, acknowledged: ['email', 'ip_address'] }).unacknowledged
    ).toEqual([]);
    expect(partly.ok).toBe(true);
  });
});

describe('incident budget', () => {
  it('sums code points across parts', () => {
    expect(incidentPublicTextLength(['abc', '\u{1F600}\u{1F600}'])).toBe(5);
  });
});

describe('length is measured on the stored form and checked first', () => {
  it('rejects a body that escaping pushes past the limit', () => {
    const body = 'a_b '.repeat(1000).trim();
    expect(Array.from(body).length).toBeLessThanOrEqual(TEXT_LIMITS.updateBody);
    const result = validatePublicText('updateBody', body, options);
    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(['too_long']);
    expect(validatePublicText('updateBody', 'a_b '.repeat(700).trim(), options).ok).toBe(true);
  });

  it('applies the same rule to postmortem bodies', () => {
    expect(codes(validatePublicText('postmortemBody', '_'.repeat(11_000), options).errors)).toEqual(['too_long']);
  });

  it('returns too_long alone, without linting or parsing an over-limit text', () => {
    const text = `${'x'.repeat(TEXT_LIMITS.updateBody)} contact jane.doe@example.org at 10.0.0.1 {placeholder}`;
    const result = validatePublicText('updateBody', text, options);
    expect(codes(result.errors)).toEqual(['too_long']);
    expect(result.warnings).toEqual([]);
    expect(result.unacknowledged).toEqual([]);
  });
});

describe('lint patterns stay linear on adversarial input', () => {
  const limit = TEXT_LIMITS.postmortemBody;
  const fill = (unit: string) => unit.repeat(Math.ceil(limit / unit.length)).slice(0, limit);
  const inputs: Record<string, string> = {
    'stack trace, unmatched parens': `at ${'x(:1:1'.repeat(3_400)}`.slice(0, limit),
    'stack trace, one long frame': `at ${'x'.repeat(limit - 3)}`,
    'newlines only': '\n'.repeat(limit),
    'blank lines with spaces': fill(' \n'),
    'repeated at': fill('at '),
    'repeated at with parens': fill('at x('),
    'email local part': fill('a'),
    'email with one at sign at the end': `${'a'.repeat(limit - 1)}@`,
    'email, many at signs': fill('a@'),
    'email, dotless domain': `a@${'a'.repeat(limit - 2)}`,
    'hostname labels': fill('a.'),
    'hostname, dashed labels': fill('a-'),
    'hostname, empty labels before a tail': fill('..local'),
    'raw html openers': fill('<a'),
    'image openers': fill('!['),
    'image labels without a destination': fill('![]('),
    'link-like openers': fill('[a]('),
    'bracket runs': fill('['),
    'list marker with a line separator': `- ${' '.repeat(limit - 3)}\u2028`,
    digits: fill('1'),
    hex: fill('a'),
    'arn prefixes': fill('arn:'),
    'ipv6 groups': fill('0:'),
    'ticket shapes': fill('A-'),
    'hash numbers': fill(' #1'),
    placeholders: fill('{a'),
    'error words': fill('Error'),
  };

  it.each(Object.entries(inputs))('%s', (_name, text) => {
    expect(text.length).toBe(limit);
    const started = performance.now();
    validatePublicText('postmortemBody', text, options);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('still finds the shapes the old patterns found', () => {
    const find = (text: string) => validatePublicText('updateBody', text, options).warnings.map(w => w.match);
    expect(find('Seen on db-1.prod.internal today')).toEqual(['db-1.prod.internal']);
    expect(find('Mail jane.doe@example.org now')).toEqual(['jane.doe@example.org']);
    expect(find('Mail a@b and x@y.z')).toEqual(['x@y.z']);
    expect(find('ok\n    at run (/srv/app.js:10:5)\nok')).toEqual(['at run (/srv/app.js:10:5)']);
    expect(find('plain text at (home:1:1)')).toEqual([]);
  });
});

describe('stored form', () => {
  it('returns the sanitized form of a markdown field', () => {
    const body = 'Some *text*, and [a link](https://app.example.com/x) plus [bad](https://evil.example.org/).';
    const result = validatePublicText('updateBody', body, options);
    expect(result.stored).toBe(sanitizeMarkdown(result.normalized, options));
  });

  it('is absent for a plain-text field and for a text over the limit before formatting', () => {
    expect(validatePublicText('title', 'Chat is slow', options).stored).toBeUndefined();
    expect(validatePublicText('updateBody', 'x'.repeat(TEXT_LIMITS.updateBody + 1), options).stored).toBeUndefined();
  });

  it('is returned with the once-formatted rejection', () => {
    const result = validatePublicText('updateBody', 'a_b '.repeat(1000).trim(), options);
    expect(result.ok).toBe(false);
    expect(result.stored).toBe(sanitizeMarkdown(result.normalized, options));
  });
});
