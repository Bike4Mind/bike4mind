import { describe, it, expect } from 'vitest';
import { simpleParser } from 'mailparser';
import { authenticateSender, findTopmostAuthenticationResults, parseAuthenticationResults } from './authenticateSender';
import type { EmailAddress } from './types';

const fromAddress = (...addresses: string[]): EmailAddress => ({
  value: addresses.map(address => ({ address, name: '' })),
  text: addresses.join(', '),
});

// Shape of the header SES prepends to a received message, folded as it is on the wire.
const sesAuthenticationResults = (results: string[]) =>
  ['amazonses.com;', ...results.map(result => ` ${result};`)].join('\r\n');

const GMAIL_SPF =
  'spf=pass (spfCheck: domain of _spf.google.com designates 209.85.128.41 as permitted sender) client-ip=209.85.128.41; envelope-from=alice@gmail.com; helo=mail-wm1-f41.google.com';

describe('parseAuthenticationResults', () => {
  it('parses the SES header, ignoring comments and the segments that are not a method result', () => {
    const results = parseAuthenticationResults(
      sesAuthenticationResults([GMAIL_SPF, 'dkim=pass header.i=@gmail.com', 'dmarc=pass header.from=gmail.com'])
    );

    expect(results).toEqual({
      authservId: 'amazonses.com',
      spf: [{ result: 'pass', properties: { 'client-ip': '209.85.128.41' } }],
      dkim: [{ result: 'pass', properties: { 'header.i': '@gmail.com' } }],
      dmarc: [{ result: 'pass', properties: { 'header.from': 'gmail.com' } }],
    });
  });

  it('keeps every dkim result when a message carries several signatures', () => {
    const results = parseAuthenticationResults(
      'amazonses.com; dkim=fail header.d=example.com; dkim=pass header.d=mailer.net'
    );

    expect(results.dkim.map(({ result }) => result)).toEqual(['fail', 'pass']);
  });
});

describe('findTopmostAuthenticationResults', () => {
  it('returns the SES header and ignores a look-alike the sender placed lower in the message', async () => {
    const raw = [
      'Return-Path: <attacker@evil.example>',
      'Received: from mx.evil.example by inbound-smtp.us-east-1.amazonaws.com',
      'Authentication-Results: amazonses.com;',
      ' spf=pass client-ip=203.0.113.9; envelope-from=attacker@evil.example;',
      ' dkim=none;',
      ' dmarc=fail header.from=gmail.com;',
      'Authentication-Results: amazonses.com; dkim=pass header.i=@gmail.com; dmarc=pass header.from=gmail.com',
      'From: alice@gmail.com',
      'To: inbox@app.example.com',
      'Subject: spoofed',
      '',
      'body',
    ].join('\r\n');

    const parsed = await simpleParser(Buffer.from(raw));
    const topmost = findTopmostAuthenticationResults(parsed.headerLines);

    expect(topmost).toBe(
      'amazonses.com; spf=pass client-ip=203.0.113.9; envelope-from=attacker@evil.example; dkim=none; dmarc=fail header.from=gmail.com;'
    );
    expect(authenticateSender(parsed.from, topmost)).toEqual({ authenticated: false, reason: 'dmarc-failed' });
  });

  it('returns undefined when the message has no Authentication-Results header', () => {
    expect(findTopmostAuthenticationResults([{ key: 'from', line: 'From: alice@gmail.com' }])).toBeUndefined();
  });
});

describe('authenticateSender', () => {
  it('accepts a DMARC pass for the From domain', () => {
    const header = sesAuthenticationResults([
      GMAIL_SPF,
      'dkim=pass header.i=@gmail.com',
      'dmarc=pass header.from=gmail.com',
    ]);

    expect(authenticateSender(fromAddress('Alice@Gmail.com'), header)).toEqual({
      authenticated: true,
      senderDomain: 'gmail.com',
      via: 'dmarc',
    });
  });

  it('rejects a DMARC pass evaluated against a different domain than the From address', () => {
    const header = sesAuthenticationResults(['dmarc=pass header.from=evil.example']);

    expect(authenticateSender(fromAddress('alice@gmail.com'), header)).toEqual({
      authenticated: false,
      reason: 'dmarc-domain-mismatch',
    });
  });

  it.each(['fail', 'temperror', 'permerror', 'quarantine'])('rejects dmarc=%s', result => {
    const header = sesAuthenticationResults(['dkim=pass header.i=@gmail.com', `dmarc=${result} header.from=gmail.com`]);

    expect(authenticateSender(fromAddress('alice@gmail.com'), header)).toEqual({
      authenticated: false,
      reason: 'dmarc-failed',
    });
  });

  describe('when the From domain publishes no DMARC record', () => {
    it.each([
      ['the From domain', 'dkim=pass header.i=@corp.example'],
      ['a parent of the From domain', 'dkim=pass header.d=corp.example'],
    ])('accepts a DKIM pass signed by %s', (_label, dkim) => {
      const header = sesAuthenticationResults([dkim, 'dmarc=none header.from=mail.corp.example']);
      const from = dkim.includes('header.i') ? 'bob@corp.example' : 'bob@mail.corp.example';

      expect(authenticateSender(fromAddress(from), header)).toMatchObject({ authenticated: true, via: 'aligned-dkim' });
    });

    it('rejects a DKIM pass from an unrelated signer', () => {
      const header = sesAuthenticationResults([
        'dkim=pass header.d=bulkmailer.example',
        'dmarc=none header.from=corp.example',
      ]);

      expect(authenticateSender(fromAddress('bob@corp.example'), header)).toEqual({
        authenticated: false,
        reason: 'no-aligned-dkim',
      });
    });

    it('rejects a DKIM pass from a domain that merely ends with the same letters', () => {
      const header = sesAuthenticationResults([
        'dkim=pass header.d=example.com',
        'dmarc=none header.from=badexample.com',
      ]);

      expect(authenticateSender(fromAddress('bob@badexample.com'), header)).toMatchObject({ authenticated: false });
    });

    it('rejects an SPF pass on its own, which authenticates the envelope sender rather than the From address', () => {
      const header = sesAuthenticationResults(['spf=pass client-ip=203.0.113.9', 'dkim=none', 'dmarc=none']);

      expect(authenticateSender(fromAddress('bob@corp.example'), header)).toEqual({
        authenticated: false,
        reason: 'no-aligned-dkim',
      });
    });
  });

  it('fails closed when the header is missing', () => {
    expect(authenticateSender(fromAddress('alice@gmail.com'), undefined)).toEqual({
      authenticated: false,
      reason: 'missing-authentication-results',
    });
  });

  it('rejects a header stamped by anyone but SES', () => {
    const header = 'mx.evil.example; dkim=pass header.i=@gmail.com; dmarc=pass header.from=gmail.com';

    expect(authenticateSender(fromAddress('alice@gmail.com'), header)).toEqual({
      authenticated: false,
      reason: 'untrusted-authserv-id',
    });
  });

  it('rejects a message with several From addresses', () => {
    const header = sesAuthenticationResults(['dmarc=pass header.from=gmail.com']);

    expect(authenticateSender(fromAddress('alice@gmail.com', 'attacker@evil.example'), header)).toEqual({
      authenticated: false,
      reason: 'multiple-senders',
    });
  });

  it('rejects a message with no From address', () => {
    const header = sesAuthenticationResults(['dmarc=pass header.from=gmail.com']);

    expect(authenticateSender(undefined, header)).toEqual({ authenticated: false, reason: 'missing-sender' });
  });
});
