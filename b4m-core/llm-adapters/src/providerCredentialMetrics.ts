/**
 * Records which credential each AnthropicBackend/OpenAIBackend `complete()` call used,
 * so a workload identity federation rollout can be verified per stage and a fall back
 * to a static key is visible. It counts `complete()` calls, not HTTP requests: every tool
 * round re-enters `complete()`, so it is roughly one datapoint per provider request. SDK
 * retries sit under one datapoint, and the max-tool-call wrap-up branch adds one without
 * its own request.
 *
 * `static` covers every plain key string, including a user's own key: the backend
 * cannot tell a platform key from a user key, only a key from the federated sentinel.
 * Because user keys stay `static`, that series will not reach zero after a cutover; verify
 * a rollout by `federated` rising, not `static` disappearing.
 *
 * Keep the names below in sync with infra/alarms.ts (`providerCredentialFallback`); the
 * tests pin the literals.
 */
export const PROVIDER_CREDENTIAL_NAMESPACE = 'Lumina5/ProviderCredential';
export const PROVIDER_CREDENTIAL_USE_METRIC = 'ProviderCredentialUse';
export const PROVIDER_CREDENTIAL_FALLBACK_METRIC = 'ProviderCredentialFallback';

export type CredentialProvider = 'anthropic' | 'openai';
export type ProviderCredentialKind = 'static' | 'federated' | 'static_fallback';

/**
 * Writes one CloudWatch EMF line to stdout. Synchronous, so it is never lost when a Lambda
 * returns fast (e.g. an auth failure right after the call). Gated on
 * PROVIDER_CREDENTIAL_METRICS (set by infra/providerFederation.ts) so other runtimes
 * (CLI, self-host, tests) stay quiet.
 */
export function recordProviderCredentialUse(provider: CredentialProvider, credential: ProviderCredentialKind): void {
  const stage = process.env.SEED_STAGE_NAME;
  if (!stage || process.env.PROVIDER_CREDENTIAL_METRICS !== 'true') return;

  try {
    const isFallback = credential === 'static_fallback';
    const directives = [
      {
        Namespace: PROVIDER_CREDENTIAL_NAMESPACE,
        Dimensions: [['Stage', 'Provider', 'Credential']],
        Metrics: [{ Name: PROVIDER_CREDENTIAL_USE_METRIC, Unit: 'Count' }],
      },
    ];
    // An alarm matches one exact dimension set, so the fallback also gets a
    // Stage-only metric of its own that one alarm covers for both providers.
    if (isFallback) {
      directives.push({
        Namespace: PROVIDER_CREDENTIAL_NAMESPACE,
        Dimensions: [['Stage']],
        Metrics: [{ Name: PROVIDER_CREDENTIAL_FALLBACK_METRIC, Unit: 'Count' }],
      });
    }
    // eslint-disable-next-line no-console -- an EMF line must reach stdout as top-level JSON; Logger would nest it under `message`
    console.info(
      JSON.stringify({
        event: 'providerCredentialUse',
        Stage: stage,
        Provider: provider,
        Credential: credential,
        [PROVIDER_CREDENTIAL_USE_METRIC]: 1,
        ...(isFallback ? { [PROVIDER_CREDENTIAL_FALLBACK_METRIC]: 1 } : {}),
        _aws: { Timestamp: Date.now(), CloudWatchMetrics: directives },
      })
    );
  } catch {
    // Observability must never break the completion it reports on.
  }
}
