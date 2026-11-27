/**
 * Per-stage provider spend scope for the spend crons (providerUsagePoll, spendReconciliation): which
 * workspaces/projects and API keys of the provider organization belong to this stage. See
 * b4m-core/services/src/spendReconciliation/providerSpendScope.ts for the value format.
 *
 * Hosted stages keep it in an SSM parameter (created in infra/providerSpendScope.ts, value ignored
 * after creation) so an operator can set it with `aws ssm put-parameter --overwrite` and no deploy;
 * the env var below holds the parameter name. Elsewhere (self-host) the env var
 * PROVIDER_SPEND_SCOPE_<PROVIDER> holds the JSON itself. Unset means organization-wide.
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { spendReconciliationService } from '@bike4mind/services';
import type { AdminKeyProvider } from './providerAdminKey';

type ProviderSpendScopes = spendReconciliationService.ProviderSpendScopes;

/** Must match providerSpendScopeParameterEnvName in infra/providerSpendScope.ts. */
export const providerSpendScopeParameterEnvName = (provider: AdminKeyProvider) =>
  `PROVIDER_SPEND_SCOPE_PARAMETER_${provider.toUpperCase()}`;

export const providerSpendScopeValueEnvName = (provider: AdminKeyProvider) =>
  `PROVIDER_SPEND_SCOPE_${provider.toUpperCase()}`;

export interface ScopeParameterReader {
  getParameter(name: string): Promise<string | undefined>;
}

let client: SSMClient | undefined;

const ssmReader: ScopeParameterReader = {
  async getParameter(name) {
    client ??= new SSMClient({});
    const result = await client.send(new GetParameterCommand({ Name: name }));
    return result.Parameter?.Value;
  },
};

/**
 * The provider's scope, or undefined for organization-wide. Throws when the parameter cannot be read
 * or its value is invalid, so the run fails that provider instead of comparing the whole
 * organization against this stage's ledger.
 */
export async function readProviderSpendScope<P extends AdminKeyProvider>(
  provider: P,
  reader: ScopeParameterReader = ssmReader,
  env: NodeJS.ProcessEnv = process.env
): Promise<ProviderSpendScopes[P] | undefined> {
  const parameterName = env[providerSpendScopeParameterEnvName(provider)]?.trim();
  const raw = parameterName ? await reader.getParameter(parameterName) : env[providerSpendScopeValueEnvName(provider)];
  return spendReconciliationService.parseProviderSpendScope(provider, raw);
}

/** Short, id-free description of a scope for log lines. */
export function describeProviderSpendScope(scope: object | undefined): string {
  if (!scope) return 'org';
  return Object.entries(scope)
    .map(([dimension, ids]) => `${dimension}:${Array.isArray(ids) ? ids.length : 0}`)
    .join(',');
}
