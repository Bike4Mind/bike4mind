/**
 * @vitest-environment node
 *
 * Secrets delivered through ECS task secrets must not also be linked or set as plain task
 * environment, and the injected names must match what the app reads (SST_RESOURCE_<Name> via the
 * sst Resource module, or the exact env var for the direct reader).
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readInfra = (file: string) =>
  readFileSync(path.join(REPO_ROOT, 'infra', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const cut = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
};

const RESOURCE_NAMES = [
  'MONGODB_URI',
  'JWT_SECRET',
  'SESSION_SECRET',
  'SECRET_ENCRYPTION_KEY',
  'SECRET_ENCRYPTION_KEY_PREVIOUS',
  'MEMORY_KEY_SECRET',
  'OAUTH_RSA_PRIVATE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'CHAT_COMPLETION_INTERNAL_SECRET',
];
const ENV_NAME = 'OPTIHASHI_INSTANCE_SERVICE_TOKEN';

const chatCompletion = readInfra('chatCompletion.ts');
const service = cut(chatCompletion, "new sst.aws.Service('ChatCompletion'", '\n});');
const fanout = cut(readInfra('subscriberFanout.ts'), "new sst.aws.Service('subscriberFanoutV2'", '\n});');
const helper = readInfra('ecsSecrets.ts');

describe('ChatCompletion ECS secrets', () => {
  const nameList = cut(chatCompletion, 'const ecsSecretNames = [', '] as const;');

  it('moves exactly the expected resource names', () => {
    const names = [...nameList.matchAll(/'([A-Z0-9_]+)'/g)].map(m => m[1]);
    expect(names.sort()).toEqual([...RESOURCE_NAMES].sort());
  });

  it('links the remaining secrets and passes the ssm map', () => {
    const link = cut(service, '\n  link: [', '\n  ],');
    expect(link).toMatch(/^\s+\.\.\.linkedSecrets,$/m);
    expect(link).not.toContain('allSecrets');
    expect(service).toMatch(/^\s+ssm: ecsSecretParameters,$/m);
    expect(chatCompletion).toContain(
      "ecsResourceSecrets('ChatCompletion', Object.fromEntries(ecsSecretNames.map(n => [n, secrets[n]])), {"
    );
    expect(chatCompletion).toMatch(/advanced: \['OAUTH_RSA_PRIVATE_KEY'\]/);
    expect(chatCompletion).toContain(
      'const ecsSecretParameters = ecsSecretGroups && Object.assign({}, ...ecsSecretGroups.map(g => g.ssm));'
    );
  });

  it('sets the parameter version fingerprint as plain environment only when secrets are moved', () => {
    expect(service).toContain(
      '...(ecsSecretGroups ? { ECS_SECRETS_VERSION: ecsSecretsVersion(...ecsSecretGroups) } : {}),'
    );
    expect(chatCompletion).toMatch(/const ecsSecretGroups = \$dev\s+\? undefined/);
  });

  it('excludes the moved secrets from link and keeps the plain link under sst dev', () => {
    expect(chatCompletion).toMatch(/const linkedSecrets = \$dev \? allSecrets : allSecrets\.filter\(/);
    expect(chatCompletion).toContain('...ecsSecretNames.map(n => secrets[n])');
    expect(chatCompletion).toMatch(
      /ecsSecretResources: sst\.Secret\[\] = \[[\s\S]*?secrets\.OPTIHASHI_INSTANCE_SERVICE_TOKEN/
    );
  });

  it('sets the direct-read token as plain environment only under sst dev', () => {
    const env = cut(service, '\n  environment: {', '\n  },');
    const lines = env.split('\n').filter(l => l.includes(ENV_NAME));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\$dev \?/);
    expect(chatCompletion).toContain(`ecsEnvSecret('ChatCompletion', '${ENV_NAME}'`);
  });

  it('does not set any moved resource name as plain environment', () => {
    const env = cut(service, '\n  environment: {', '\n  },');
    for (const name of RESOURCE_NAMES) {
      expect(env).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});

describe('subscriberFanout ECS secrets', () => {
  it('moves MONGODB_URI out of link, with the plain link kept under sst dev', () => {
    expect(fanout).toMatch(/link: \$dev \? \[secrets\.MONGODB_URI, websocketApi\] : \[websocketApi\],/);
    expect(readInfra('subscriberFanout.ts')).toMatch(
      /const fanoutSecrets = \$dev \? undefined : ecsResourceSecrets\('subscriberFanoutV2', \{ MONGODB_URI: secrets\.MONGODB_URI \}\)/
    );
    expect(readInfra('subscriberFanout.ts')).toContain('ssm: fanoutSecrets?.ssm,');
  });

  it('sets the parameter version fingerprint as plain environment only when secrets are moved', () => {
    expect(fanout).toContain('...(fanoutSecrets ? { ECS_SECRETS_VERSION: ecsSecretsVersion(fanoutSecrets) } : {}),');
  });
});

describe('ecsSecrets helper', () => {
  it('exposes parameter versions and builds the fingerprint from versions only', () => {
    expect(helper).toContain('versions.push(parameter.version);');
    expect(helper).toContain('versions: [parameter.version]');
    const fn = cut(helper, 'export function ecsSecretsVersion', '\n}');
    expect(fn).toContain('$interpolate');
    expect(fn).not.toContain('.value');
  });

  it('stores resource secrets as {"value": ...} under SST_RESOURCE_<Name> keyed to the parameter ARN', () => {
    expect(helper).toContain('$jsonStringify({ value: secret.value })');
    expect(helper).toContain('`SST_RESOURCE_${name}`, parameter.arn');
    expect(helper).toContain("type: 'SecureString'");
  });

  it('stores the direct-read env secret raw under its exact env name', () => {
    const fn = cut(helper, 'export function ecsEnvSecret', '\n}');
    expect(fn).toContain('value: secret.value,');
    expect(fn).toContain('{ [envName]: parameter.arn }');
  });
});
