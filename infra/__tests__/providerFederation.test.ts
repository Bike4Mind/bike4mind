/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import { buildProviderFederation, type ProviderFederationDeployEnv } from '../providerFederation';

const INFRA_DIR = join(__dirname, '..');
const read = (file: string) => readFileSync(join(INFRA_DIR, file), 'utf8');

const CONFIGURED: ProviderFederationDeployEnv = {
  B4M_PROVIDER_AUTH_FEDERATED: 'true',
  ANTHROPIC_FEDERATION_RULE_ID: 'rule',
  ANTHROPIC_ORGANIZATION_ID: 'org',
  ANTHROPIC_WIF_AUDIENCE: 'anthropic-aud',
  OPENAI_IDENTITY_PROVIDER_ID: 'idp',
  OPENAI_SERVICE_ACCOUNT_ID: 'sa',
  OPENAI_WIF_AUDIENCE: 'openai-aud',
};

describe('buildProviderFederation', () => {
  it.each([undefined, '', 'false', 'TRUE', '1'])('is empty when the toggle is %j', toggle => {
    expect(buildProviderFederation({ ...CONFIGURED, B4M_PROVIDER_AUTH_FEDERATED: toggle })).toEqual({
      environment: {},
      permissions: [],
    });
  });

  it('is empty with nothing configured', () => {
    expect(buildProviderFederation({})).toEqual({ environment: {}, permissions: [] });
  });

  it('emits the runtime env and the STS grant when on', () => {
    expect(buildProviderFederation(CONFIGURED)).toEqual({
      environment: {
        B4M_PROVIDER_AUTH: 'federated',
        PROVIDER_WIF_TOKEN_SOURCE: 'aws-sts',
        ANTHROPIC_FEDERATION_RULE_ID: 'rule',
        ANTHROPIC_ORGANIZATION_ID: 'org',
        ANTHROPIC_WIF_AUDIENCE: 'anthropic-aud',
        OPENAI_IDENTITY_PROVIDER_ID: 'idp',
        OPENAI_SERVICE_ACCOUNT_ID: 'sa',
        OPENAI_WIF_AUDIENCE: 'openai-aud',
      },
      permissions: [
        {
          actions: ['sts:GetWebIdentityToken'],
          resources: ['*'],
          conditions: [
            {
              test: 'ForAllValues:StringEquals',
              variable: 'sts:IdentityTokenAudience',
              values: ['anthropic-aud', 'openai-aud'],
            },
          ],
        },
      ],
    });
  });

  it('passes the optional Anthropic ids only when set', () => {
    const { environment } = buildProviderFederation({
      ...CONFIGURED,
      ANTHROPIC_SERVICE_ACCOUNT_ID: 'asa',
      ANTHROPIC_WORKSPACE_ID: ' ',
    });
    expect(environment.ANTHROPIC_SERVICE_ACCOUNT_ID).toBe('asa');
    expect(environment).not.toHaveProperty('ANTHROPIC_WORKSPACE_ID');
  });

  it('fails the deploy when on with a required id missing', () => {
    expect(() => buildProviderFederation({ ...CONFIGURED, OPENAI_WIF_AUDIENCE: '' })).toThrow(
      /requires OPENAI_WIF_AUDIENCE/
    );
  });
});

/** infra file -> text on the nearest declaration line above the spread (the function running ChatCompletionProcess). */
const CHAT_PATH_FUNCTIONS: Record<string, string> = {
  'web.ts': 'sst.aws.Nextjs',
  'chatCompletion.ts': 'sst.aws.Service',
  'functions.ts': 'slackQuestProcessor',
};

describe('providerFederation wiring', () => {
  it.each(Object.entries(CHAT_PATH_FUNCTIONS))('%s spreads env and permissions into %s', (file, owner) => {
    const src = read(file);
    for (const spread of ['...providerFederation.environment,', '...providerFederation.permissions,']) {
      const at = src.indexOf(spread);
      expect(at, spread).toBeGreaterThan(-1);
      expect(src.indexOf(spread, at + 1), `${spread} appears once`).toBe(-1);
      const declarations = src
        .slice(0, at)
        .split('\n')
        .filter(line => /handler:|new sst\.aws\./.test(line));
      expect(declarations[declarations.length - 1]).toContain(owner);
    }
  });

  it('is referenced only by the chat path functions', () => {
    const referencing = readdirSync(INFRA_DIR)
      .filter(f => f.endsWith('.ts') && f !== 'providerFederation.ts')
      .filter(f => read(f).includes('providerFederation'));
    expect(referencing.sort()).toEqual(Object.keys(CHAT_PATH_FUNCTIONS).sort());
  });
});
