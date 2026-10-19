import { describe, it, expect } from 'vitest';
import {
  normalizeDnsName,
  uniqueValidationRecords,
  pickHostedZone,
  compareRecord,
  formatProblems,
} from '../check-acm-validation-records.mjs';

// Fixtures use example.com and made-up tokens only: real validation names and values are
// account-specific and must never appear in this repo.

const option = (domain, name, value) => ({
  DomainName: domain,
  ResourceRecord: { Name: name, Type: 'CNAME', Value: value },
});

const zone = (name, privateZone = false) => ({
  Id: `/hostedzone/${name}`,
  Name: `${name}.`,
  Config: { PrivateZone: privateZone },
});

describe('normalizeDnsName', () => {
  it('lowercases and drops the trailing dot', () => {
    expect(normalizeDnsName('_ABC.App.Example.com.')).toBe('_abc.app.example.com');
  });
});

describe('uniqueValidationRecords', () => {
  it('merges a base domain and its wildcard, which share one record', () => {
    const records = uniqueValidationRecords([
      option('app.example.com', '_tok1.app.example.com.', '_val1.acm-validations.aws.'),
      option('*.app.example.com', '_tok1.app.example.com.', '_val1.acm-validations.aws.'),
      option('*.usercontent.app.example.com', '_tok2.usercontent.app.example.com.', '_val2.acm-validations.aws.'),
    ]);
    expect(records).toEqual([
      {
        name: '_tok1.app.example.com',
        type: 'CNAME',
        value: '_val1.acm-validations.aws',
        domains: ['app.example.com', '*.app.example.com'],
      },
      {
        name: '_tok2.usercontent.app.example.com',
        type: 'CNAME',
        value: '_val2.acm-validations.aws',
        domains: ['*.usercontent.app.example.com'],
      },
    ]);
  });

  it('skips options ACM has not populated a record for yet', () => {
    expect(uniqueValidationRecords([{ DomainName: 'app.example.com' }, undefined])).toEqual([]);
    expect(uniqueValidationRecords(undefined)).toEqual([]);
  });
});

describe('pickHostedZone', () => {
  const zones = [zone('example.com'), zone('app.example.com'), zone('app.example.com', true), zone('other.com')];

  it('picks the longest public zone that contains the record', () => {
    expect(pickHostedZone('_tok.app.example.com', zones).Name).toBe('app.example.com.');
    expect(pickHostedZone('_tok.example.com', zones).Name).toBe('example.com.');
  });

  it('ignores private zones and unrelated suffixes', () => {
    expect(pickHostedZone('_tok.notexample.com', zones)).toBeNull();
    expect(pickHostedZone('_tok.app.example.com', [zone('app.example.com', true)])).toBeNull();
  });
});

describe('compareRecord', () => {
  const required = { name: '_tok1.app.example.com', type: 'CNAME', value: '_val1.acm-validations.aws' };
  const found = (name, value, type = 'CNAME') => ({ Name: name, Type: type, ResourceRecords: [{ Value: value }] });

  it('accepts the exact record, ignoring case and trailing dots', () => {
    expect(compareRecord(required, found('_TOK1.app.example.com.', '_val1.acm-validations.aws.'))).toBe('ok');
  });

  it('reports a deleted record (Route53 returns the next name, or nothing)', () => {
    expect(compareRecord(required, null)).toBe('missing');
    expect(compareRecord(required, found('_zzz.app.example.com.', '_val1.acm-validations.aws.'))).toBe('missing');
    expect(compareRecord(required, found('_tok1.app.example.com.', '1.2.3.4', 'A'))).toBe('missing');
  });

  it('reports a record whose value no longer matches the certificate', () => {
    expect(compareRecord(required, found('_tok1.app.example.com.', '_other.acm-validations.aws.'))).toBe('wrong-value');
  });
});

describe('formatProblems', () => {
  it('names the domains and the fix, never the record name or value', () => {
    const text = formatProblems(
      [
        { domains: ['app.example.com', '*.app.example.com'], status: 'missing' },
        { domains: ['*.usercontent.app.example.com'], status: 'wrong-value' },
      ],
      'pr123'
    );
    expect(text).toContain('app.example.com, *.app.example.com: its validation record is missing from Route53');
    expect(text).toContain('*.usercontent.app.example.com: its validation record has a different value');
    expect(text).toContain('sst refresh --stage pr123 --target Router');
    expect(text).not.toContain('_tok');
    expect(text).not.toContain('acm-validations');
  });
});
