/**
 * Per-stage provider spend scope read by the spend crons (apps/workers/src/cron/providerSpendScope.ts):
 * the provider workspaces/projects and API keys that belong to this stage, so the provider reports
 * are compared with this stage's ledger only. One SSM parameter per provider, not a secret, so an
 * operator can set it with `aws ssm put-parameter --overwrite` and no deploy; the value is ignored
 * after creation for that reason. The default `org` keeps the organization-wide comparison.
 *
 * Value format (JSON), see b4m-core/services/src/spendReconciliation/providerSpendScope.ts:
 *   anthropic: {"workspaceIds": [...], "apiKeyIds": [...]}  ("default" names the default workspace)
 *     The nightly cost report can only group by workspace, so apiKeyIds narrow the hourly poller
 *     but not the nightly reconciliation: scope by workspace where the stage has its own.
 *   openai:    {"projectIds": [...], "apiKeyIds": [...]}
 *
 * Imports only constants so infra/cron.ts can import it without a cycle.
 */

import { runsScheduledJobs } from './constants';
import { PROVIDER_ADMIN_KEY_PROVIDERS, type ProviderAdminKeyProvider } from './providerAdminKeys';

/** Must match providerSpendScopeParameterEnvName in apps/workers/src/cron/providerSpendScope.ts. */
export const providerSpendScopeParameterEnvName = (provider: ProviderAdminKeyProvider) =>
  `PROVIDER_SPEND_SCOPE_PARAMETER_${provider.toUpperCase()}`;

export const providerSpendScopeParameterName = (app: string, stage: string, provider: ProviderAdminKeyProvider) =>
  `/${app}/${stage}/provider-spend-scope/${provider}`;

const providerSpendScopeParameters = runsScheduledJobs
  ? PROVIDER_ADMIN_KEY_PROVIDERS.map(
      provider =>
        new aws.ssm.Parameter(
          `ProviderSpendScope-${provider}`,
          {
            name: providerSpendScopeParameterName($app.name, $app.stage, provider),
            type: 'String',
            value: 'org',
            description: `${provider} workspaces/projects and API keys counted as this stage's spend (JSON, or org)`,
          },
          { ignoreChanges: ['value'] }
        )
    )
  : undefined;

/** Env vars and the read permission a spend cron needs. Empty where the parameters do not exist. */
export function providerSpendScopeCronAccess(): {
  environment: Record<string, string>;
  permissions: { actions: string[]; resources: $util.Input<string>[] }[];
} {
  if (!providerSpendScopeParameters) return { environment: {}, permissions: [] };
  return {
    environment: Object.fromEntries(
      PROVIDER_ADMIN_KEY_PROVIDERS.map(provider => [
        providerSpendScopeParameterEnvName(provider),
        providerSpendScopeParameterName($app.name, $app.stage, provider),
      ])
    ),
    permissions: [{ actions: ['ssm:GetParameter'], resources: providerSpendScopeParameters.map(p => p.arn) }],
  };
}
