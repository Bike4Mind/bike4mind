import { describe, it, expect } from 'vitest';
import { deduplicateLeaks, hashSecret } from '../secrets-scan-summarize-and-ingest.mjs';
import { isPlaceholderLeak } from '../secrets-scan-summarize-and-ingest.mjs';

describe('hashSecret', () => {
  it('returns a stable hex string for a given value', () => {
    const h1 = hashSecret('mysecret');
    const h2 = hashSecret('mysecret');
    expect(h1).toBe(h2);
    expect(typeof h1).toBe('string');
    expect(h1.length).toBe(64); // SHA-256 hex
  });

  it('returns different hashes for different values', () => {
    expect(hashSecret('abc')).not.toBe(hashSecret('def'));
  });
});

describe('deduplicateLeaks', () => {
  it('collapses two findings with the same ruleId and secret into one alert', () => {
    const leaks = [
      {
        RuleID: 'bike4mind-mongodb-uri',
        Description: 'MongoDB Connection String',
        StartLine: 5,
        File: 'scripts/old.ts',
        Commit: 'aaa',
        Secret: 'mongodb+srv://user:pass@cluster.net/db',
        Tags: ['mongodb'],
      },
      {
        RuleID: 'bike4mind-mongodb-uri',
        Description: 'MongoDB Connection String',
        StartLine: 12,
        File: 'scripts/other.ts',
        Commit: 'bbb',
        Secret: 'mongodb+srv://user:pass@cluster.net/db',
        Tags: ['mongodb'],
      },
    ];

    const result = deduplicateLeaks(leaks);
    expect(result).toHaveLength(1);
    expect(result[0].locations).toHaveLength(2);
    expect(result[0].locations[0].filePath).toBe('scripts/old.ts');
    expect(result[0].locations[1].filePath).toBe('scripts/other.ts');
  });

  it('keeps two findings with different secrets as separate alerts', () => {
    const leaks = [
      {
        RuleID: 'bike4mind-mongodb-uri',
        Description: 'MongoDB Connection String',
        StartLine: 5,
        File: 'scripts/a.ts',
        Commit: 'aaa',
        Secret: 'mongodb+srv://user:pass1@cluster.net/db',
        Tags: [],
      },
      {
        RuleID: 'bike4mind-mongodb-uri',
        Description: 'MongoDB Connection String',
        StartLine: 5,
        File: 'scripts/b.ts',
        Commit: 'bbb',
        Secret: 'mongodb+srv://user:pass2@cluster.net/db',
        Tags: [],
      },
    ];

    const result = deduplicateLeaks(leaks);
    expect(result).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(deduplicateLeaks([])).toEqual([]);
  });

  it('handles leaks with missing Secret field gracefully', () => {
    const leaks = [
      {
        RuleID: 'bike4mind-mongodb-uri',
        Description: 'MongoDB Connection String',
        StartLine: 5,
        File: 'scripts/a.ts',
        Commit: 'aaa',
        Secret: undefined,
        Tags: [],
      },
    ];
    const result = deduplicateLeaks(leaks);
    expect(result).toHaveLength(1);
  });

  it('keeps two findings with different rules but no Secret as separate alerts', () => {
    const leaks = [
      {
        RuleID: 'bike4mind-mongodb-uri',
        Description: 'MongoDB Connection String',
        StartLine: 5,
        File: 'scripts/a.ts',
        Commit: 'aaa',
        Secret: undefined,
        Tags: [],
      },
      {
        RuleID: 'bike4mind-slack-webhook',
        Description: 'Slack Webhook URL',
        StartLine: 10,
        File: 'scripts/b.ts',
        Commit: 'bbb',
        Secret: undefined,
        Tags: [],
      },
    ];
    const result = deduplicateLeaks(leaks);
    expect(result).toHaveLength(2);
  });
});

describe('isPlaceholderLeak', () => {
  it('returns true for a finding in a .test.ts file', () => {
    expect(isPlaceholderLeak({ File: 'src/services/foo.test.ts', Secret: 'AIzaSyAbcDefGhi1234567890123456789' })).toBe(true);
  });

  it('returns true for a finding in a __tests__ directory', () => {
    expect(isPlaceholderLeak({ File: 'src/__tests__/auth.ts', Secret: 'sk-ant-abc123' })).toBe(true);
  });

  it('returns true for a .env.example file', () => {
    expect(isPlaceholderLeak({ File: '.env.example', Secret: 'some-key' })).toBe(true);
  });

  it('returns true when secret value is a known placeholder string', () => {
    expect(isPlaceholderLeak({ File: 'src/config.ts', Secret: 'your-secret-here' })).toBe(true);
    expect(isPlaceholderLeak({ File: 'src/config.ts', Secret: 'changeme' })).toBe(true);
    expect(isPlaceholderLeak({ File: 'src/config.ts', Secret: 'AKIAIOSFODNN7EXAMPLE' })).toBe(true);
    expect(isPlaceholderLeak({ File: 'src/config.ts', Secret: 'not-configured' })).toBe(true);
    expect(isPlaceholderLeak({ File: 'src/config.ts', Secret: 'my-secret-placeholder-value' })).toBe(true);
  });

  it('returns false for a real-looking secret in a production source file', () => {
    expect(isPlaceholderLeak({ File: 'src/services/auth.ts', Secret: 'mongodb+srv://user:R3alP4ss!@cluster.mongodb.net/db' })).toBe(false);
  });
});
