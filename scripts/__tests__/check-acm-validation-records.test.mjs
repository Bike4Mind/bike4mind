import { describe, it, expect } from 'vitest';
import {
  normalizeDnsName,
  uniqueValidationRecords,
  pickHostedZone,
  compareRecord,
  formatProblems,
  redactAccountIds,
  runAwsCli,
  run,
  CheckError,
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

  it('matches a record named exactly like the zone', () => {
    expect(pickHostedZone('app.example.com', zones).Name).toBe('app.example.com.');
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

describe('formatProblems for a domain with no hosted zone', () => {
  it('points at the hosted zone, not at sst refresh', () => {
    const text = formatProblems([{ domains: ['*.usercontent.app.example.com'], status: 'no-zone' }], 'pr1');
    expect(text).toContain('no public hosted zone covers its validation record');
    expect(text).toContain('create or delegate a public hosted zone');
    expect(text).not.toContain('sst refresh');
  });
});

describe('redactAccountIds', () => {
  it('masks 12-digit account ids and keeps other numbers', () => {
    expect(redactAccountIds('arn:aws:acm:us-east-1:123456789012:certificate/x port 443')).toBe(
      'arn:aws:acm:us-east-1:<account>:certificate/x port 443'
    );
  });
});

describe('runAwsCli', () => {
  it('reports a missing aws CLI without a stack trace', () => {
    const exec = () => {
      throw Object.assign(new Error('spawnSync aws ENOENT'), { code: 'ENOENT' });
    };
    expect(() => runAwsCli(['acm', 'list-certificates'], exec)).toThrow(new CheckError('aws CLI not found on PATH'));
  });

  it('redacts account ids from a failed call', () => {
    const exec = () => {
      throw Object.assign(new Error('Command failed'), {
        stderr: 'AccessDenied for arn:aws:iam::123456789012:role/deployer',
      });
    };
    expect(() => runAwsCli(['acm', 'describe-certificate'], exec)).toThrow(
      'aws acm describe-certificate failed: AccessDenied for arn:aws:iam::<account>:role/deployer'
    );
  });

  it('parses JSON output', () => {
    expect(runAwsCli(['route53', 'list-hosted-zones'], () => '{"HostedZones":[]}')).toEqual({ HostedZones: [] });
  });
});

describe('run', () => {
  const certDomain = 'app.example.com';
  const required = {
    DomainName: certDomain,
    ResourceRecord: { Name: '_tok1.app.example.com.', Type: 'CNAME', Value: '_val1.acm-validations.aws.' },
  };
  const certs = {
    'arn:used': { DomainName: certDomain, InUseBy: ['cloudfront'], DomainValidationOptions: [required] },
    'arn:unused': {
      DomainName: certDomain,
      InUseBy: [],
      DomainValidationOptions: [
        { DomainName: certDomain, ResourceRecord: { Name: '_gone.app.example.com.', Type: 'CNAME', Value: '_x.' } },
      ],
    },
  };

  // A fake aws CLI answering from fixtures; `records` is what Route53 holds.
  function fakeAws({ issued = ['arn:used'], pending = [], records = [] } = {}) {
    return args => {
      const op = `${args[0]} ${args[1]}`;
      if (op === 'acm list-certificates') {
        const arns = args.includes('ISSUED') ? issued : pending;
        return { CertificateSummaryList: arns.map(arn => ({ CertificateArn: arn, DomainName: certDomain })) };
      }
      if (op === 'acm describe-certificate') return { Certificate: certs[args[args.indexOf('--certificate-arn') + 1]] };
      if (op === 'route53 list-hosted-zones') return { HostedZones: [zone('app.example.com')] };
      if (op === 'route53 list-resource-record-sets') {
        const name = args[args.indexOf('--start-record-name') + 1];
        const hit = records.find(r => normalizeDnsName(r.Name) >= name);
        return { ResourceRecordSets: hit ? [hit] : [] };
      }
      throw new Error(`unexpected call: ${op}`);
    };
  }

  function capture() {
    const out = { log: [], warn: [], error: [] };
    return { out, log: { log: m => out.log.push(m), warn: m => out.warn.push(m), error: m => out.error.push(m) } };
  }

  const present = {
    Name: '_tok1.app.example.com.',
    Type: 'CNAME',
    ResourceRecords: [{ Value: '_val1.acm-validations.aws.' }],
  };

  it('skips when APP_CERT_ARN is set, without calling aws', () => {
    const { log } = capture();
    const aws = () => {
      throw new Error('should not be called');
    };
    expect(run({ env: { APP_CERT_ARN: 'x', SERVER_DOMAIN: 'example.com' }, argv: [], aws, log })).toBe(0);
  });

  it('passes when every validation record of the in-use cert is present', () => {
    const { out, log } = capture();
    expect(run({ env: { SERVER_DOMAIN: 'example.com' }, argv: [], aws: fakeAws({ records: [present] }), log })).toBe(0);
    expect(out.log.join('\n')).toContain('ACM validation records OK for app.example.com (1 record(s) checked)');
  });

  it('fails when a record of the in-use cert is missing', () => {
    const { out, log } = capture();
    const code = run({ env: { SERVER_DOMAIN: 'example.com', SEED_STAGE_NAME: 'pr1' }, argv: [], aws: fakeAws(), log });
    expect(code).toBe(1);
    expect(out.error.join('\n')).toContain('app.example.com: its validation record is missing from Route53');
  });

  it('only warns about an unused issued cert whose records are gone', () => {
    const { out, log } = capture();
    const aws = fakeAws({ issued: ['arn:used', 'arn:unused'], records: [present] });
    expect(run({ env: { SERVER_DOMAIN: 'example.com' }, argv: [], aws, log })).toBe(0);
    expect(out.warn.join('\n')).toContain('1 issued certificate(s) for app.example.com are not in use');
  });

  it('reports but does not fail with ACM_VALIDATION_CHECK=warn', () => {
    const { out, log } = capture();
    const env = { SERVER_DOMAIN: 'example.com', ACM_VALIDATION_CHECK: 'warn' };
    expect(run({ env, argv: [], aws: fakeAws(), log })).toBe(0);
    expect(out.warn.join('\n')).toContain('continuing anyway');
  });

  it('uses --domain over SERVER_DOMAIN and rejects an empty --domain', () => {
    const { log } = capture();
    expect(
      run({ env: {}, argv: ['node', 'x', '--domain', 'app.example.com'], aws: fakeAws({ records: [present] }), log })
    ).toBe(0);
    expect(() => run({ env: {}, argv: ['node', 'x', '--domain'], aws: fakeAws(), log })).toThrow(CheckError);
  });
});
