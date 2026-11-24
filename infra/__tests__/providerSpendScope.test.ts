// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Read as text: importing the worker would pull the AWS SDK and the services package into infra tests.
const workerSource = readFileSync(
  new URL('../../apps/workers/src/cron/providerSpendScope.ts', import.meta.url),
  'utf8'
);
const workerParameterEnvTemplate =
  /providerSpendScopeParameterEnvName = [^`]*`([A-Z_]+)\$\{provider\.toUpperCase\(\)\}`/.exec(workerSource)?.[1];

const state = vi.hoisted(() => ({ runsScheduledJobs: true }));

vi.mock('../constants', () => ({
  get runsScheduledJobs() {
    return state.runsScheduledJobs;
  },
}));

// The real module creates the admin key stores at load; only the provider list matters here.
vi.mock('../providerAdminKeys', () => ({ PROVIDER_ADMIN_KEY_PROVIDERS: ['anthropic', 'openai'] }));

const parameter = vi.fn(function (_name: string, args: { name: string }) {
  return { arn: `arn:test:ssm:us-east-2:123456789012:parameter${args.name}` };
});

async function load(runsScheduledJobs: boolean) {
  vi.resetModules();
  state.runsScheduledJobs = runsScheduledJobs;
  vi.stubGlobal('$app', { name: 'test-app', stage: 'production' });
  vi.stubGlobal('aws', { ssm: { Parameter: parameter } });
  return import('../providerSpendScope');
}

afterEach(() => {
  vi.unstubAllGlobals();
  parameter.mockClear();
});

describe('providerSpendScopeCronAccess', () => {
  it('uses the parameter env var prefix the worker reads', () => {
    expect(workerParameterEnvTemplate).toBe('PROVIDER_SPEND_SCOPE_PARAMETER_');
  });

  it('names the env vars the worker reads and grants read on the two parameters only', async () => {
    const { providerSpendScopeCronAccess } = await load(true);

    const access = providerSpendScopeCronAccess();

    expect(access.environment).toEqual({
      [`${workerParameterEnvTemplate}ANTHROPIC`]: '/test-app/production/provider-spend-scope/anthropic',
      [`${workerParameterEnvTemplate}OPENAI`]: '/test-app/production/provider-spend-scope/openai',
    });
    expect(access.permissions).toEqual([
      {
        actions: ['ssm:GetParameter'],
        resources: [
          'arn:test:ssm:us-east-2:123456789012:parameter/test-app/production/provider-spend-scope/anthropic',
          'arn:test:ssm:us-east-2:123456789012:parameter/test-app/production/provider-spend-scope/openai',
        ],
      },
    ]);
  });

  it('creates nothing and grants nothing on a stage without the spend crons', async () => {
    const { providerSpendScopeCronAccess } = await load(false);

    expect(providerSpendScopeCronAccess()).toEqual({ environment: {}, permissions: [] });
    expect(parameter).not.toHaveBeenCalled();
  });
});
