import { describe, it, expect } from 'vitest';
import { bedrockClientCredentials } from './bedrockCredentials';

// AWS's documented example key pair; must not trip the placeholder check.
const KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const MINIO = { AWS_ACCESS_KEY_ID: 'minioadmin', AWS_SECRET_ACCESS_KEY: 'minioadmin' };

describe('bedrockClientCredentials', () => {
  it('hosted uses the default chain: no explicit credentials', () => {
    expect(bedrockClientCredentials({})).toEqual({});
    expect(bedrockClientCredentials({ BEDROCK_AWS_ACCESS_KEY_ID: KEY, BEDROCK_AWS_SECRET_ACCESS_KEY: SECRET })).toEqual(
      {}
    );
  });

  it('self-host without BEDROCK_AWS_* is unreachable', () => {
    expect(bedrockClientCredentials({ B4M_SELF_HOST: 'true' })).toBeNull();
  });

  it('self-host never falls back to the MinIO AWS_* pair', () => {
    expect(bedrockClientCredentials({ B4M_SELF_HOST: 'true', ...MINIO })).toBeNull();
  });

  it('self-host with the BEDROCK pair returns trimmed credentials', () => {
    expect(
      bedrockClientCredentials({
        B4M_SELF_HOST: 'true',
        ...MINIO,
        BEDROCK_AWS_ACCESS_KEY_ID: ` ${KEY} `,
        BEDROCK_AWS_SECRET_ACCESS_KEY: SECRET,
      })
    ).toEqual({ credentials: { accessKeyId: KEY, secretAccessKey: SECRET } });
  });

  it('includes the session token when set', () => {
    expect(
      bedrockClientCredentials({
        B4M_SELF_HOST: 'true',
        BEDROCK_AWS_ACCESS_KEY_ID: KEY,
        BEDROCK_AWS_SECRET_ACCESS_KEY: SECRET,
        BEDROCK_AWS_SESSION_TOKEN: 'tok',
      })
    ).toEqual({ credentials: { accessKeyId: KEY, secretAccessKey: SECRET, sessionToken: 'tok' } });
  });

  it.each([
    ['blank key', '  ', SECRET],
    ['blank secret', KEY, ''],
    ['placeholder key', 'your-api-key', SECRET],
    ['placeholder secret', KEY, 'CHANGE_ME'],
  ])('treats a %s as absent', (_label, key, secret) => {
    expect(
      bedrockClientCredentials({
        B4M_SELF_HOST: 'true',
        BEDROCK_AWS_ACCESS_KEY_ID: key,
        BEDROCK_AWS_SECRET_ACCESS_KEY: secret,
      })
    ).toBeNull();
  });
});
