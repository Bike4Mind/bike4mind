import { describe, it, expect } from 'vitest';
import { simpleParser } from 'mailparser';
import { authenticateSender, parseAuthenticationResults, readSenderAuthenticationHeaders } from './authenticateSender';
import type { EmailAddress } from './types';

const fromAddress = (...addresses: string[]): EmailAddress => ({
  value: addresses.map(address => ({ address, name: '' })),
  text: addresses.join(', '),
});

// Shape of the header SES prepends to a received message: one result per folded line.
const sesAuthenticationResults = (results: string[]) =>
  ['amazonses.com;', ...results.map(result => ` ${result};`)].join('\r\n');

const sesHeaders = (results: string[]) => ({
  authenticationResults: sesAuthenticationResults(results),
  fromHeaderCount: 1,
});

const GMAIL_SPF =
  'spf=pass (spfCheck: domain of _spf.google.com designates 209.85.128.41 as permitted sender) client-ip=209.85.128.41; envelope-from=alice@gmail.com; helo=mail-wm1-f41.google.com';

describe('parseAuthenticationResults', () => {
  it('reads the leading result on each line, ignoring comments and the MAIL FROM / HELO echo', () => {
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
      sesAuthenticationResults(['dkim=fail header.d=example.com', 'dkim=pass header.d=mailer.net'])
    );

    expect(results.dkim.map(({ result }) => result)).toEqual(['fail', 'pass']);
  });

  it('ignores results that are not on a line of their own', () => {
    const results = parseAuthenticationResults('amazonses.com; dkim=pass header.d=gmail.com; dmarc=pass');

    expect(results).toMatchObject({ authservId: 'amazonses.com', dkim: [], dmarc: [] });
  });
});

describe('readSenderAuthenticationHeaders', () => {
  it('returns the SES header and ignores a look-alike the sender placed lower in the message', async () => {
    const raw = [
      'Return-Path: <attacker@evil.example>',
      'Received: from mx.evil.example by inbound-smtp.us-east-1.amazonaws.com',
      'Authentication-Results: amazonses.com;',
      ' spf=pass client-ip=203.0.113.9; envelope-from=attacker@evil.example;',
      ' dkim=none;',
      ' dmarc=fail header.from=gmail.com;',
      'Authentication-Results: amazonses.com;',
      ' dkim=pass header.i=@gmail.com;',
      ' dmarc=pass header.from=gmail.com;',
      'From: alice@gmail.com',
      'To: inbox@app.example.com',
      'Subject: spoofed',
      '',
      'body',
    ].join('\r\n');

    const parsed = await simpleParser(Buffer.from(raw));
    const headers = readSenderAuthenticationHeaders(parsed.headerLines);

    expect(headers).toEqual({
      authenticationResults: [
        'amazonses.com;',
        ' spf=pass client-ip=203.0.113.9; envelope-from=attacker@evil.example;',
        ' dkim=none;',
        ' dmarc=fail header.from=gmail.com;',
      ].join('\r\n'),
      fromHeaderCount: 1,
    });
    expect(authenticateSender(parsed.from, headers)).toEqual({ authenticated: false, reason: 'dmarc-failed' });
  });

  it('counts a second From header that the parser itself drops', async () => {
    const raw = [
      'Authentication-Results: amazonses.com;',
      ' dkim=pass header.i=@gmail.com;',
      ' dmarc=pass header.from=gmail.com;',
      'From: alice@gmail.com',
      'From: attacker@evil.example',
      'To: inbox@app.example.com',
      '',
      'body',
    ].join('\r\n');

    const parsed = await simpleParser(Buffer.from(raw));

    expect(authenticateSender(parsed.from, readSenderAuthenticationHeaders(parsed.headerLines))).toEqual({
      authenticated: false,
      reason: 'multiple-senders',
    });
  });

  it('returns no Authentication-Results when the message has none', () => {
    expect(readSenderAuthenticationHeaders([{ key: 'from', line: 'From: alice@gmail.com' }])).toEqual({
      authenticationResults: undefined,
      fromHeaderCount: 1,
    });
  });
});

describe('authenticateSender', () => {
  it('accepts a DMARC pass for the From domain', () => {
    const headers = sesHeaders([GMAIL_SPF, 'dkim=pass header.i=@gmail.com', 'dmarc=pass header.from=gmail.com']);

    expect(authenticateSender(fromAddress('Alice@Gmail.com'), headers)).toEqual({
      authenticated: true,
      senderDomain: 'gmail.com',
      via: 'dmarc',
    });
  });

  it('compares an internationalized From domain in its punycode form', () => {
    const headers = sesHeaders(['dmarc=pass header.from=xn--bcher-kva.de']);

    expect(authenticateSender(fromAddress('boss@bücher.de'), headers)).toMatchObject({ authenticated: true });
  });

  it('ignores a trailing dot on the From domain', () => {
    const headers = sesHeaders(['dmarc=pass header.from=victim.com']);

    expect(authenticateSender(fromAddress('boss@victim.com.'), headers)).toMatchObject({ authenticated: true });
  });

  it('rejects a DMARC pass evaluated against a different domain than the From address', () => {
    const headers = sesHeaders(['dmarc=pass header.from=evil.example']);

    expect(authenticateSender(fromAddress('alice@gmail.com'), headers)).toEqual({
      authenticated: false,
      reason: 'dmarc-domain-mismatch',
    });
  });

  it.each(['fail', 'temperror', 'permerror', 'quarantine'])('rejects dmarc=%s', result => {
    const headers = sesHeaders(['dkim=pass header.i=@gmail.com', `dmarc=${result} header.from=gmail.com`]);

    expect(authenticateSender(fromAddress('alice@gmail.com'), headers)).toEqual({
      authenticated: false,
      reason: 'dmarc-failed',
    });
  });

  it('rejects a header with no dmarc result rather than treating it as no DMARC record', () => {
    const headers = sesHeaders(['dkim=pass header.i=@victim.com']);

    expect(authenticateSender(fromAddress('boss@victim.com'), headers)).toEqual({
      authenticated: false,
      reason: 'missing-dmarc-result',
    });
  });

  it('rejects a header with more than one dmarc result', () => {
    const headers = sesHeaders(['dmarc=pass header.from=victim.com', 'dmarc=fail header.from=victim.com']);

    expect(authenticateSender(fromAddress('boss@victim.com'), headers)).toEqual({
      authenticated: false,
      reason: 'multiple-dmarc-results',
    });
  });

  describe('against results smuggled through the MAIL FROM and HELO that SES echoes', () => {
    it.each([
      [
        'a quoted MAIL FROM local part',
        'spf=pass (spfCheck: ok) client-ip=1.2.3.4; envelope-from="a;dmarc=pass header.from=victim.com x"@evil.com; helo=mx.evil.com',
      ],
      [
        'a HELO containing ";"',
        'spf=pass client-ip=1.2.3.4; envelope-from=a@evil.com; helo=x;dmarc=pass\theader.from=victim.com',
      ],
      ['a nested comment', 'spf=pass (a (b) ; dmarc=pass header.from=victim.com x) client-ip=1.2.3.4'],
    ])('keeps the real dmarc=fail despite %s', (_label, spfLine) => {
      const headers = sesHeaders([spfLine, 'dkim=none', 'dmarc=fail header.from=victim.com']);

      expect(authenticateSender(fromAddress('boss@victim.com'), headers)).toEqual({
        authenticated: false,
        reason: 'dmarc-failed',
      });
    });

    it('does not take a smuggled dkim pass when the From domain has no DMARC record', () => {
      const headers = sesHeaders([
        'spf=pass client-ip=1.2.3.4; envelope-from=a@evil.com; helo=x;dkim=pass header.i=@victim.com',
        'dkim=none',
        'dmarc=none header.from=victim.com',
      ]);

      expect(authenticateSender(fromAddress('boss@victim.com'), headers)).toEqual({
        authenticated: false,
        reason: 'no-aligned-dkim',
      });
    });
  });

  describe('when the From domain publishes no DMARC record', () => {
    it.each([
      ['the From domain', 'dkim=pass header.i=@corp.example', 'bob@corp.example'],
      ['a parent of the From domain', 'dkim=pass header.d=corp.example', 'bob@mail.corp.example'],
      ['a subdomain of the From domain', 'dkim=pass header.i=@mail.corp.example', 'bob@corp.example'],
    ])('accepts a DKIM pass signed by %s', (_label, dkim, from) => {
      const headers = sesHeaders([dkim, 'dmarc=none']);

      expect(authenticateSender(fromAddress(from), headers)).toMatchObject({
        authenticated: true,
        via: 'aligned-dkim',
      });
    });

    it('rejects a DKIM pass from an unrelated signer', () => {
      const headers = sesHeaders(['dkim=pass header.d=bulkmailer.example', 'dmarc=none header.from=corp.example']);

      expect(authenticateSender(fromAddress('bob@corp.example'), headers)).toEqual({
        authenticated: false,
        reason: 'no-aligned-dkim',
      });
    });

    it('rejects a DKIM pass from a domain that merely ends with the same letters', () => {
      const headers = sesHeaders(['dkim=pass header.d=example.com', 'dmarc=none header.from=badexample.com']);

      expect(authenticateSender(fromAddress('bob@badexample.com'), headers)).toMatchObject({ authenticated: false });
    });

    it('rejects an SPF pass on its own, which authenticates the envelope sender rather than the From address', () => {
      const headers = sesHeaders(['spf=pass client-ip=203.0.113.9', 'dkim=none', 'dmarc=none']);

      expect(authenticateSender(fromAddress('bob@corp.example'), headers)).toEqual({
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
    expect(authenticateSender(fromAddress('alice@gmail.com'), { fromHeaderCount: 1 })).toEqual({
      authenticated: false,
      reason: 'missing-authentication-results',
    });
  });

  it('rejects a header stamped by anyone but SES', () => {
    const headers = {
      authenticationResults:
        'mx.evil.example;\r\n dkim=pass header.i=@gmail.com;\r\n dmarc=pass header.from=gmail.com;',
      fromHeaderCount: 1,
    };

    expect(authenticateSender(fromAddress('alice@gmail.com'), headers)).toEqual({
      authenticated: false,
      reason: 'untrusted-authserv-id',
    });
  });

  it('rejects a message with several From addresses', () => {
    const headers = sesHeaders(['dmarc=pass header.from=gmail.com']);

    expect(authenticateSender(fromAddress('alice@gmail.com', 'attacker@evil.example'), headers)).toEqual({
      authenticated: false,
      reason: 'multiple-senders',
    });
  });

  it('rejects a message with no From address', () => {
    const headers = sesHeaders(['dmarc=pass header.from=gmail.com']);

    expect(authenticateSender(undefined, headers)).toEqual({ authenticated: false, reason: 'missing-sender' });
  });
});
