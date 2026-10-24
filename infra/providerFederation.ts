/**
 * Deploy-time opt-in for provider workload identity federation on the chat completion path
 * (b4m-core/llm-adapters providerAuth.ts, wifTokenSource.ts). Off unless the deploy sets
 * B4M_PROVIDER_AUTH_FEDERATED=true; off yields empty env and permissions, so the functions
 * spreading it are unchanged. Spread into every function that runs ChatCompletionProcess
 * (the listed functions are checked by infra/__tests__/providerFederation.test.ts).
 */
export interface ProviderFederationDeployEnv {
  B4M_PROVIDER_AUTH_FEDERATED?: string;
  ANTHROPIC_FEDERATION_RULE_ID?: string;
  ANTHROPIC_ORGANIZATION_ID?: string;
  ANTHROPIC_SERVICE_ACCOUNT_ID?: string;
  ANTHROPIC_WORKSPACE_ID?: string;
  ANTHROPIC_WIF_AUDIENCE?: string;
  OPENAI_IDENTITY_PROVIDER_ID?: string;
  OPENAI_SERVICE_ACCOUNT_ID?: string;
  OPENAI_WIF_AUDIENCE?: string;
}

export interface ProviderFederation {
  environment: Record<string, string>;
  permissions: Array<{
    actions: string[];
    resources: string[];
    conditions: Array<{ test: string; variable: string; values: string[] }>;
  }>;
}

const REQUIRED = [
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_WIF_AUDIENCE',
  'OPENAI_IDENTITY_PROVIDER_ID',
  'OPENAI_SERVICE_ACCOUNT_ID',
  'OPENAI_WIF_AUDIENCE',
] as const;

const OPTIONAL = ['ANTHROPIC_SERVICE_ACCOUNT_ID', 'ANTHROPIC_WORKSPACE_ID'] as const;

export function buildProviderFederation(env: ProviderFederationDeployEnv): ProviderFederation {
  if (env.B4M_PROVIDER_AUTH_FEDERATED !== 'true') return { environment: {}, permissions: [] };

  const missing = REQUIRED.filter(key => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`B4M_PROVIDER_AUTH_FEDERATED=true requires ${missing.join(', ')} at deploy time`);
  }

  const environment: Record<string, string> = {
    B4M_PROVIDER_AUTH: 'federated',
    PROVIDER_WIF_TOKEN_SOURCE: 'aws-sts',
  };
  for (const key of [...REQUIRED, ...OPTIONAL]) {
    const value = env[key]?.trim();
    if (value) environment[key] = value;
  }

  return {
    environment,
    // GetWebIdentityToken supports no resource-level scoping.
    permissions: [
      {
        actions: ['sts:GetWebIdentityToken'],
        resources: ['*'],
        conditions: [
          {
            test: 'ForAllValues:StringEquals',
            variable: 'sts:IdentityTokenAudience',
            values: [...new Set([environment.ANTHROPIC_WIF_AUDIENCE!, environment.OPENAI_WIF_AUDIENCE!])],
          },
        ],
      },
    ],
  };
}

// Each read is spelled out so scripts/check-deploy-contract.py sees it.
export const providerFederation = buildProviderFederation({
  B4M_PROVIDER_AUTH_FEDERATED: process.env.B4M_PROVIDER_AUTH_FEDERATED,
  ANTHROPIC_FEDERATION_RULE_ID: process.env.ANTHROPIC_FEDERATION_RULE_ID,
  ANTHROPIC_ORGANIZATION_ID: process.env.ANTHROPIC_ORGANIZATION_ID,
  ANTHROPIC_SERVICE_ACCOUNT_ID: process.env.ANTHROPIC_SERVICE_ACCOUNT_ID,
  ANTHROPIC_WORKSPACE_ID: process.env.ANTHROPIC_WORKSPACE_ID,
  ANTHROPIC_WIF_AUDIENCE: process.env.ANTHROPIC_WIF_AUDIENCE,
  OPENAI_IDENTITY_PROVIDER_ID: process.env.OPENAI_IDENTITY_PROVIDER_ID,
  OPENAI_SERVICE_ACCOUNT_ID: process.env.OPENAI_SERVICE_ACCOUNT_ID,
  OPENAI_WIF_AUDIENCE: process.env.OPENAI_WIF_AUDIENCE,
});
