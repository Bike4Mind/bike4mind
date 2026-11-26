import { CloudWatchClient, PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';
import type { MetricDatum } from '@aws-sdk/client-cloudwatch';
import { Logger } from '@bike4mind/observability';

/**
 * Records which credential each Anthropic/OpenAI completion request used, so a
 * workload identity federation rollout can be verified per stage and a fall back
 * to a static key is visible.
 *
 * `static` covers every plain key string, including a user's own key: the backend
 * cannot tell a platform key from a user key, only a key from the federated sentinel.
 *
 * Keep the names below in sync with infra/alarms.ts (`providerCredentialFallback`);
 * the tests pin the literals.
 */
export const PROVIDER_CREDENTIAL_NAMESPACE = 'Lumina5/ProviderCredential';
export const PROVIDER_CREDENTIAL_USE_METRIC = 'ProviderCredentialUse';
export const PROVIDER_CREDENTIAL_FALLBACK_METRIC = 'ProviderCredentialFallback';

export type CredentialProvider = 'anthropic' | 'openai';
export type ProviderCredentialKind = 'static' | 'federated' | 'static_fallback';

function buildMetricData(
  stage: string,
  provider: CredentialProvider,
  credential: ProviderCredentialKind,
  timestamp: Date
): MetricDatum[] {
  const count = { Value: 1, Unit: StandardUnit.Count, Timestamp: timestamp };
  const usage: MetricDatum = {
    ...count,
    MetricName: PROVIDER_CREDENTIAL_USE_METRIC,
    Dimensions: [
      { Name: 'Stage', Value: stage },
      { Name: 'Provider', Value: provider },
      { Name: 'Credential', Value: credential },
    ],
  };
  if (credential !== 'static_fallback') return [usage];

  // An alarm matches one exact dimension set, so the fallback also gets a
  // Stage-only metric of its own that one alarm covers for both providers.
  return [
    usage,
    { ...count, MetricName: PROVIDER_CREDENTIAL_FALLBACK_METRIC, Dimensions: [{ Name: 'Stage', Value: stage }] },
  ];
}

/**
 * Fire-and-forget: never throws and never blocks the request it reports on.
 * No-ops outside deployed stages (`SEED_STAGE_NAME` comes from
 * DEFAULT_LAMBDA_ENVIRONMENT in infra/constants.ts): CLI, self-host and tests.
 */
export async function recordProviderCredentialUse(
  provider: CredentialProvider,
  credential: ProviderCredentialKind,
  logger?: Logger
): Promise<void> {
  const stage = process.env.SEED_STAGE_NAME;
  if (!stage) return;

  try {
    // Fresh client per call: warm Lambda containers outlive their credentials.
    const client = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-east-2' });
    await client.send(
      new PutMetricDataCommand({
        Namespace: PROVIDER_CREDENTIAL_NAMESPACE,
        MetricData: buildMetricData(stage, provider, credential, new Date()),
      })
    );
  } catch (error) {
    (logger ?? Logger.globalInstance).warn('[provider-credential] Failed to emit ProviderCredentialUse metric', {
      provider,
      credential,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
